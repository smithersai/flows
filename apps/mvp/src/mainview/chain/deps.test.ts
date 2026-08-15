import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Author, Catalog, Chain, Journal, QuickJsRunner, ScriptRunner } from "@smthrs/chain";
import type { Event, Outcome } from "@smthrs/chain";

/*
 * DESIGN.md §14 dependency law, proven not asserted: @smthrs/chain resolves
 * through the vendored closure (vendor/smthrs, scripts/vendor-smthrs.mjs),
 * runs under bun, seals in QuickJS, and stays browser-bundleable. Vendoring
 * keeps one effect instance in the graph — Bun symlinks file: deps, and a
 * package resolving effect from a sibling repo's node_modules would load a
 * second copy whose identity-keyed features (Redacted, references) cannot
 * see this one's. If a re-vendor breaks any of that, this file fails before
 * any product code does.
 */

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n");

const scripts = [
	flow(
		`const hits = await ctx.call("grep", { pattern: "TODO" })`,
		`const s = await ctx.call("author", { context: [hits.files.join("\\n")] })`,
		`return to(s)`,
	),
	flow(`await ctx.call("edit", { file: "a.ts" })`, `return done({ patched: true })`),
];

const grep = {
	name: "grep",
	description: "test grep",
	handler: () => Effect.succeed({ files: ["a.ts", "b.ts"] }),
};
const edit = { name: "edit", description: "test edit", handler: () => Effect.succeed({ ok: true }) };

const runChain = (runner: Layer.Layer<ScriptRunner.ScriptRunner, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const outcome = yield* Chain.run({ goal: "patch TODOs" });
			const journal = yield* Journal.Journal;
			const events = yield* journal.read;
			return { outcome, events };
		}).pipe(
			Effect.provide(
				(() => {
					const base = Layer.mergeAll(Journal.layerMemory([]), Author.layerMock(scripts), runner);
					return Layer.mergeAll(base, Catalog.layer([grep, edit]).pipe(Layer.provide(base)));
				})(),
			),
		) as Effect.Effect<
			{ outcome: Outcome.Terminal; events: ReadonlyArray<Event.Event> },
			never,
			never
		>,
	);

describe("@smthrs/chain resolves and runs under mvp", () => {
	test("a two-link chain reaches done through the in-process runner", async () => {
		const { outcome, events } = await runChain(ScriptRunner.layerInProcess);
		expect(outcome._tag).toBe("Done");
		const tags = events.map((event) => event._tag);
		expect(tags).toContain("ChainStarted");
		expect(tags).toContain("LinkAuthored");
		expect(tags).toContain("CallSettled");
		expect(tags).toContain("LinkEnded");
	});

	test("the same chain reaches done through the QuickJS sealed realm", async () => {
		const { outcome } = await runChain(QuickJsRunner.layer());
		expect(outcome._tag).toBe("Done");
	});
});

describe("chain stays browser-bundleable", () => {
	test("Bun.build bundles @smthrs/chain for the browser target", async () => {
		const entry = join(import.meta.dir, "bundle-entry.fixture.ts");
		const result = await Bun.build({ entrypoints: [entry], target: "browser" });
		expect(result.success).toBe(true);
	}, 30000);
});

/*
 * AGENTS.md "New Smithers only": legacy runtime packages from ~/smithers use
 * the retired @smithers scope; product code may only import the new @smthrs
 * packages owned by ../flows. Scans all product source, not just shared.
 */
describe("legacy scope boundary", () => {
	test("no src module imports the retired @smithers/* scope", () => {
		const roots = [join(import.meta.dir, "..", "..")];
		const offenders: Array<string> = [];
		while (roots.length > 0) {
			const dir = roots.pop() as string;
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) {
					roots.push(path);
					continue;
				}
				if (!/\.(ts|tsx)$/.test(name)) continue;
				if (/from\s+"@smithers\//.test(readFileSync(path, "utf8"))) offenders.push(path);
			}
		}
		expect(offenders).toEqual([]);
	});
});
