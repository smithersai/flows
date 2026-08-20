/*
 * The hermetic e2e harness — the runner.
 *
 * Usage: bun e2e/run.ts [--suite <substring>]... [--phase A|B] [--port <n>]
 *                       [--skip-build] [--list] [--allow-unproven]
 *
 * Suites are discovered from the filesystem, so adding one is adding a file:
 * there is no registry to edit and no merge conflict between lanes. The stack
 * boots once per phase and every suite in that phase shares it, so the whole
 * set costs the same two wrangler boots and one vite build that
 * scripts/worker-e2e.ts costs today.
 *
 * Two properties the runner owes CI:
 *
 *  - It always terminates. Every suite runs under a deadline, so one stuck
 *    page cannot park the job until the 30-minute CI timeout kills it with
 *    nothing to show.
 *  - It never reports more than it proved. The runner knows which checklist
 *    ids each suite claims and which ones actually printed, and a claim that
 *    did not print fails the run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReporter, SuiteFailure, type Reporter } from "./Assert.ts";
import { createE2eBrowser } from "./Browser.ts";
import { closeOpenClients } from "./Client.ts";
import { buildSpa, startStack } from "./Stack.ts";
import type { Phase, Suite } from "./Suite.ts";

/**
 * How long one suite may run before the runner cuts it off. The slowest suite
 * today takes 31s, so ten minutes trips on a hang and on nothing else.
 */
const SUITE_TIMEOUT_MS = Number(process.env.FLOWS_E2E_SUITE_TIMEOUT_MS ?? 600_000);

interface Options {
	readonly filters: ReadonlyArray<string>;
	readonly phase: Phase | undefined;
	readonly port: number | undefined;
	readonly skipBuild: boolean;
	readonly list: boolean;
	/** Report unproven checklist ids without failing the run. */
	readonly allowUnproven: boolean;
}

const parseArgv = (argv: ReadonlyArray<string>): Options => {
	const filters: Array<string> = [];
	let phase: Phase | undefined;
	let port: number | undefined;
	let skipBuild = false;
	let list = false;
	let allowUnproven = process.env.FLOWS_E2E_ALLOW_UNPROVEN === "1";
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--suite") {
			const value = argv[(index += 1)];
			if (value !== undefined) filters.push(value);
		} else if (flag === "--phase") {
			const value = argv[(index += 1)];
			if (value === "A" || value === "B") phase = value;
		} else if (flag === "--port") {
			const value = argv[(index += 1)];
			if (value !== undefined) port = Number(value);
		} else if (flag === "--skip-build") {
			skipBuild = true;
		} else if (flag === "--list") {
			list = true;
		} else if (flag === "--allow-unproven") {
			allowUnproven = true;
		} else {
			throw new Error(`unknown flag ${flag}`);
		}
	}
	return { filters, phase, port, skipBuild, list, allowUnproven };
};

interface Discovered {
	readonly file: string;
	readonly suite: Suite;
	/** Every checklist id this suite claims to prove. */
	readonly claims: ReadonlyArray<string>;
}

const isSuite = (value: unknown): value is Suite =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Suite).id === "string" &&
	typeof (value as Suite).title === "string" &&
	typeof (value as Suite).run === "function";

/** A checklist id: a section number and an optional row number, e.g. "E5" or "E13.2". */
const CHECKLIST_ID = /^E\d+(?:\.\d+)?$/;

/** The leading checklist id of an `ok:` line, e.g. "E1.2 the signed-out page..." → "E1.2". */
export const leadingChecklistId = (line: string): string | undefined => {
	const first = line.trim().split(/[\s—:,]/)[0] ?? "";
	return CHECKLIST_ID.test(first) ? first : undefined;
};

/**
 * The ids a suite's `id` field names: one id, a slash or plus list, or a range.
 * "E4.5-E4.9" is the whole range; "E1-auth-session" is just the section.
 */
export const idsFromSuiteId = (suiteId: string): ReadonlyArray<string> => {
	const range = /^(E(\d+)(?:\.(\d+))?)-(E(\d+)(?:\.(\d+))?)$/.exec(suiteId);
	if (range !== null) {
		const [, , leftSection, leftRow, , rightSection, rightRow] = range;
		if (leftSection === rightSection && leftRow !== undefined && rightRow !== undefined) {
			const ids: Array<string> = [];
			for (let row = Number(leftRow); row <= Number(rightRow); row += 1) ids.push(`E${leftSection}.${row}`);
			return ids;
		}
		if (leftRow === undefined && rightRow === undefined) {
			const ids: Array<string> = [];
			for (let section = Number(leftSection); section <= Number(rightSection); section += 1) ids.push(`E${section}`);
			return ids;
		}
	}
	return [...new Set(suiteId.match(/E\d+(?:\.\d+)?/g) ?? [])];
};

/**
 * The ids a suite's source claims: the leading id of every `report.ok("...")`
 * literal in the file. Read from the source rather than declared on the suite
 * so the claim cannot drift from the lines that satisfy it, and so no suite
 * lane has to edit its file for the runner to hold it to account.
 */
export const idsFromSource = (source: string): ReadonlyArray<string> => {
	const literal = /report\.ok\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
	const ids = new Set<string>();
	for (const match of source.matchAll(literal)) {
		const id = leadingChecklistId(match[2] ?? "");
		if (id !== undefined) ids.add(id);
	}
	return [...ids];
};

const claimsOf = (suite: Suite, source: string): ReadonlyArray<string> => {
	if (suite.ids !== undefined) return [...new Set(suite.ids)];
	return [...new Set([...idsFromSuiteId(suite.id), ...idsFromSource(source)])];
};

/** A suite file that would not load: a syntax error, a bad import, a bad export. */
interface Broken {
	readonly file: string;
	readonly error: string;
	/** Still readable from the text, so a file that will not load still says what it owed. */
	readonly claims: ReadonlyArray<string>;
}

/**
 * Every suite file, loaded. A file that throws on import is recorded rather
 * than rethrown: suites are written by parallel lanes, and one lane's syntax
 * error must not stop the other sixteen suites from running and reporting.
 */
const discover = async (): Promise<{ found: ReadonlyArray<Discovered>; broken: ReadonlyArray<Broken> }> => {
	const dir = fileURLToPath(new URL("suites/", import.meta.url));
	const files: Array<string> = [];
	for await (const file of new Bun.Glob("*.e2e.ts").scan({ cwd: dir, absolute: true })) files.push(file);
	files.sort();
	const found: Array<Discovered> = [];
	const broken: Array<Broken> = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		try {
			const module = (await import(file)) as { default?: unknown };
			if (!isSuite(module.default)) throw new Error("it does not default-export a suite");
			found.push({ file, suite: module.default, claims: claimsOf(module.default, source) });
		} catch (error) {
			broken.push({
				file,
				error: error instanceof Error ? error.message : String(error),
				claims: idsFromSource(source),
			});
		}
	}
	return { found, broken };
};

const basename = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/**
 * `work`, or a distinct timeout failure once `ms` has passed. The runner
 * treats this as terminal for the run so no later suite can reuse resources
 * that timed-out work may still hold.
 */
export class SuiteTimeoutFailure extends SuiteFailure {}
export const suiteFailureAction = (error: unknown): "abort-run" | "continue" =>
	error instanceof SuiteTimeoutFailure ? "abort-run" : "continue";

const withDeadline = async <T>(what: string, ms: number, work: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
					new SuiteTimeoutFailure(
					`${what} did not finish within ${ms}ms and the runner cut it off so the run terminates (raise FLOWS_E2E_SUITE_TIMEOUT_MS if the suite is honestly this slow).`,
				),
			);
		}, ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * True once the Worker under test answers again. `wrangler dev` reloads itself
 * whenever a sibling touches apps/server or rebuilds the SPA, and a reload
 * refuses connections for a second or two, so a single refusal is not a death.
 */
const stackAlive = async (origin: string, attempts = 30): Promise<boolean> => {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
			if (response.ok) return true;
		} catch {
			// Reloading, or gone. The next attempt tells them apart.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
};

/** Records which claimed ids a suite actually printed. */
interface Outcome {
	readonly suiteId: string;
	readonly status: "pass" | "fail" | "skip";
	readonly unproven: ReadonlyArray<string>;
}

const main = async (): Promise<number> => {
	const options = parseArgv(process.argv.slice(2));
	const { found: discovered, broken } = await discover();
	const selected = discovered.filter(({ file, suite }) => {
		if (options.phase !== undefined && (suite.phase ?? "B") !== options.phase) return false;
		if (options.filters.length === 0) return true;
		return options.filters.some((filter) => suite.id.includes(filter) || basename(file).includes(filter));
	});

	// A broken file only matches by name: it has no suite object to ask.
	const brokenSelected = broken.filter(
		({ file }) => options.filters.length === 0 || options.filters.some((filter) => basename(file).includes(filter)),
	);

	if (options.list) {
		for (const { file, suite, claims } of discovered) {
			console.log(
				`${suite.id}\t${suite.phase ?? "B"}\t${suite.order ?? 0}\t${basename(file)}\t${claims.join(",") || "(no checklist id)"}`,
			);
		}
		for (const { file, error } of broken) console.log(`(did not load)\t-\t-\t${basename(file)}\t${error}`);
		return 0;
	}
	if (selected.length === 0 && brokenSelected.length === 0) {
		console.error("FAIL: apps/ui e2e — no suite matched the selection.");
		return 1;
	}

	if (!options.skipBuild) await buildSpa();

	const failed: Array<string> = [];
	const outcomes: Array<Outcome> = [];
	let passed = 0;
	let skipped = 0;
	let checks = 0;
	let claimedIds = 0;
	let timedOut = false;

	// Reported first, and red: a suite file that will not load proves nothing.
	for (const { file, error, claims } of brokenSelected) {
		claimedIds += claims.length;
		failed.push(basename(file));
		outcomes.push({ suiteId: basename(file), status: "fail", unproven: claims });
		console.error(`FAIL: ${basename(file)} — the suite file did not load: ${error}`);
	}

	for (const phase of ["B", "A"] as const) {
		if (timedOut) break;
		const inPhase = selected
			.filter(({ suite }) => (suite.phase ?? "B") === phase)
			.sort((left, right) => {
				const byOrder = (left.suite.order ?? 0) - (right.suite.order ?? 0);
				if (byOrder !== 0) return byOrder;
				const byId = left.suite.id.localeCompare(right.suite.id);
				return byId !== 0 ? byId : left.file.localeCompare(right.file);
			});
		if (inPhase.length === 0) continue;

		console.log(`\nphase ${phase}: booting wrangler dev for ${inPhase.length} suite(s)...`);
		const stack = await startStack({
			phase,
			skipBuild: true,
			...(options.port === undefined ? {} : { port: options.port }),
		});
		const browser = createE2eBrowser(stack.origin);
		try {
			for (const [index, { suite, claims }] of inPhase.entries()) {
				claimedIds += claims.length;
				/*
				 * A dead stack turns every remaining suite into the same
				 * "Unable to connect" red, which buries the one failure that
				 * matters. Say what actually happened once, and stop.
				 */
				if (!(await stackAlive(stack.origin))) {
					const stranded = inPhase.slice(index);
					for (const { suite: unrun, claims: unrunClaims } of stranded) {
						failed.push(unrun.id);
						outcomes.push({ suiteId: unrun.id, status: "fail", unproven: unrunClaims });
					}
					claimedIds += stranded.slice(1).reduce((total, entry) => total + entry.claims.length, 0);
					console.error(
						`FAIL: the stack on ${stack.origin} stopped answering before ${suite.id} — wrangler dev died, so the remaining ${stranded.length} suite(s) in phase ${phase} did not run: ${stranded.map(({ suite: unrun }) => unrun.id).join(", ")}.`,
					);
					break;
				}
				if (suite.browser === true && !browser.available) {
					console.log(`skip: ${suite.id} — ${browser.reason}`);
					skipped += 1;
					outcomes.push({ suiteId: suite.id, status: "skip", unproven: claims });
					continue;
				}
				/*
				 * The previous suite's clients stop before this one starts. A
				 * workflow run pump polls the SHARED stack until its run ends or
				 * its conversation resets, so an abandoned client keeps hammering
				 * wrangler for the rest of the phase and starves the suites after
				 * it — which is how E5's balance chip and E8's browser turn timed
				 * out at the tail of a full run while both passed alone.
				 */
				closeOpenClients();
				// Same leak on the browser side: closing a session's debugger
				// socket leaves its TAB running, pumps and all.
				await browser.closeSessions();
				await stack.reset();
				const base = createReporter(suite.id);
				// The `ok:` lines are the record of what was proven, so read the ids
				// off them rather than trusting a suite to have run every section.
				const proven = new Set<string>();
				const report: Reporter = {
					...base,
					ok: (line) => {
						const id = leadingChecklistId(line);
						if (id !== undefined) proven.add(id);
						base.ok(line);
					},
				};
				const startedAt = Date.now();
				let status: "pass" | "fail" = "pass";
				try {
					await withDeadline(
						"the suite",
						SUITE_TIMEOUT_MS,
						suite.run({ origin: stack.origin, phase, stack, report, browser }),
					);
					passed += 1;
					checks += report.okCount();
					console.log(
						`PASS: ${suite.id} — ${suite.title} (${report.okCount()} checks, ${Math.round((Date.now() - startedAt) / 1000)}s).`,
					);
				} catch (error) {
					status = "fail";
					checks += report.okCount();
					failed.push(suite.id);
					const message = error instanceof SuiteFailure || error instanceof Error ? error.message : String(error);
					console.error(`FAIL: ${suite.id} — ${message}`);
					if (!(error instanceof SuiteFailure) && error instanceof Error && error.stack !== undefined) {
						console.error(error.stack);
					}
					if (suiteFailureAction(error) === "abort-run") timedOut = true;
				}
				// A suite that passes its whole body proves the row its own id names,
				// even when its `ok:` lines carry no id prefix.
				const unproven = claims.filter(
					(id) => !proven.has(id) && !(status === "pass" && idsFromSuiteId(suite.id).includes(id)),
				);
				outcomes.push({ suiteId: suite.id, status, unproven });
				if (unproven.length > 0 && status === "pass") {
					console.log(`unproven: ${suite.id} — ${unproven.join(", ")} claimed but never printed an ok: line.`);
				}
				if (timedOut) {
					console.error("FAIL: timeout is terminal; tearing down the suite-owned browser and stack before stopping the run.");
					break;
				}
			}
		} finally {
			// The last suite's clients stop with the stack they were driving.
			closeOpenClients();
			await browser.close();
			await stack.stop();
		}
	}

	/*
	 * The vacuous-pass gate. A browser-dependent id that degraded to a `skip:`
	 * used to leave the suite reporting PASS, so a Chrome-less machine could
	 * report a green run having proved none of the browser rows. CI asserts
	 * Chrome exists, so a skip there is a defect in the runner's environment,
	 * not a licence to report the row as covered — the run fails.
	 *
	 * `--allow-unproven` (or FLOWS_E2E_ALLOW_UNPROVEN=1) downgrades the gate to
	 * a warning for a developer on a machine with no browser. CI never sets it.
	 */
	const vacuous = outcomes.filter((outcome) => outcome.status !== "fail" && outcome.unproven.length > 0);
	const unprovenAfterFailure = outcomes.filter((outcome) => outcome.status === "fail" && outcome.unproven.length > 0);
	const provenIds = claimedIds - outcomes.reduce((total, outcome) => total + outcome.unproven.length, 0);

	console.log(`\nchecklist ids: ${claimedIds} claimed, ${provenIds} proven.`);
	for (const outcome of unprovenAfterFailure) {
		console.log(`unproven (suite failed): ${outcome.suiteId} — ${outcome.unproven.join(", ")}.`);
	}
	for (const outcome of vacuous) {
		console.log(`unproven (${outcome.status}): ${outcome.suiteId} — ${outcome.unproven.join(", ")}.`);
	}

	if (failed.length > 0) {
		console.error(`\nFAIL: apps/ui e2e — ${failed.length} suite(s) failed: ${failed.join(", ")}.`);
		return 1;
	}
	if (vacuous.length > 0) {
		const ids = vacuous.flatMap((outcome) => outcome.unproven);
		if (!options.allowUnproven) {
			console.error(
				`\nFAIL: apps/ui e2e — ${passed} suites passed but ${ids.length} claimed checklist id(s) were never proven: ${ids.join(", ")}. Run with --allow-unproven on a machine with no browser.`,
			);
			return 1;
		}
		console.log(`\nWARN: apps/ui e2e — ${ids.length} claimed checklist id(s) unproven: ${ids.join(", ")}.`);
	}
	console.log(
		`\nPASS: apps/ui e2e — ${passed} suites, ${checks} checks, ${provenIds}/${claimedIds} checklist ids proven, ${skipped} skipped.`,
	);
	return 0;
};

// Guarded so the helpers above can be imported and exercised directly; `bun
// e2e/run.ts` still runs the whole thing.
if (import.meta.main) process.exit(await main());
