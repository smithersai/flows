/**
 * Wave 9 headless verification — one page: the chat, no dead ends.
 *
 *   bun scripts/live-check.ts local
 *     Boot the stub identity + `wrangler dev` and assert the signed-out CHAT
 *     (transcript + composer — there is no landing view) opens with the
 *     Smithers sign-in message and logs ZERO console errors.
 *
 *   bun scripts/live-check.ts live [out-dir]
 *     Against https://canary.smithers.sh:
 *       (a) the signed-out chat renders — transcript + composer, the opening
 *           Smithers message with the one-sentence preview, the plain-words
 *           scopes, and the sign-in action — with zero console errors and no
 *           separate landing view anywhere (screenshot),
 *       (b) the sign-in click never dead-ends: github.com's authorize page
 *           when OAuth is configured upstream, the branded honest page when
 *           it is not — and a REAL failed callback (bogus code/state) renders
 *           the honest page with the way back home, HTTP status preserved
 *           (screenshot),
 *       (c) Accept: application/json still gets the machine-readable answer.
 *     Screenshots land in reports/live-checks/<timestamp>/ by default.
 *
 * Playwright is borrowed from ~/flows/ui's node_modules — the mvp itself does
 * not depend on it — using the already-downloaded chromium build.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStubIdentity } from "./stub-backends";

interface PlaywrightPage {
	goto: (url: string) => Promise<{ status: () => number } | null>;
	waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
	waitForNavigation: (options?: { waitUntil?: string }) => Promise<{ status: () => number } | null>;
	click: (selector: string) => Promise<void>;
	url: () => string;
	textContent: (selector: string) => Promise<string | null>;
	evaluate: <T>(fn: (selector: string) => T, arg: string) => Promise<T>;
	screenshot: (options: { path: string; fullPage?: boolean }) => Promise<unknown>;
	on: (event: string, listener: (arg: { type: () => string; text: () => string }) => void) => void;
	close: () => Promise<void>;
}

interface PlaywrightBrowser {
	newPage: () => Promise<PlaywrightPage>;
	close: () => Promise<void>;
}

const require = createRequire("/Users/williamcory/flows/ui/package.json");
const { chromium } = require("playwright") as {
	chromium: { launch: (options: { headless: boolean }) => Promise<PlaywrightBrowser> };
};

const mode = process.argv[2] ?? "local";
if (mode !== "local" && mode !== "live") {
	console.error("usage: bun scripts/live-check.ts [local|live] [out-dir]");
	process.exit(1);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
	if (ok) {
		console.log(`ok: ${label} — ${detail}`);
	} else {
		failures += 1;
		console.log(`FAIL: ${label} — ${detail}`);
	}
};

/** Console errors seen on the page: error-type console messages + uncaught exceptions. */
const collectConsoleErrors = (page: PlaywrightPage): Array<string> => {
	const errors: Array<string> = [];
	page.on("console", (message) => {
		if (typeof message.type === "function" && message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
	return errors;
};

const LANDING_SENTENCE = "Smithers is a design-partner preview — sign in with GitHub to continue.";

/* ------------------------------- local mode ------------------------------- */

const WORKER_PORT = 8791;
const WORKER_ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;

/** textContent auto-waits 30s for a MISSING element — a negative probe must not. */
const present = (page: PlaywrightPage, selector: string): Promise<boolean> =>
	page.evaluate((sel) => document.querySelector(sel) !== null, selector);

/** Assert the one-page signed-out chat: transcript + composer, the opening sign-in message, no landing view. */
const checkSignedOutChat = async (page: PlaywrightPage, consoleErrors: ReadonlyArray<string>): Promise<void> => {
	try {
		await page.waitForSelector('[data-command="auth.sign-in"]', { timeout: 30_000 });
	} catch {
		check("the signed-out chat renders", false, "the sign-in action never appeared in the transcript");
		return;
	}
	// Let the boot probes (session, scopes) finish before reading the console.
	await wait(2500);
	const transcript = await page.textContent(".smithers-transcript");
	check(
		"the chat surface renders (transcript present) with the opening sign-in message",
		transcript !== null && transcript.includes(LANDING_SENTENCE),
		transcript === null ? "(no transcript)" : "sentence rides the opening Smithers message",
	);
	check(
		"the opening message states the scopes in plain words",
		transcript !== null && transcript.includes("Before GitHub asks, here is what Smithers will use:"),
		"scopes copy present",
	);
	check(
		"the composer stays visible (it IS the page)",
		await present(page, ".smithers-composer textarea"),
		"composer present",
	);
	check(
		"no separate landing view exists",
		!(await present(page, ".landing-surface")),
		"no .landing-surface element anywhere",
	);
	/*
	 * Wave 12 §4: signed out shows ONLY the auth conversation state. The seeded
	 * "tell me what you're working on" welcome used to ride UNDER the sign-in
	 * message — an invitation to a conversation this session cannot have.
	 */
	check(
		"signed out, the auth state is the WHOLE transcript",
		transcript !== null && !transcript.includes("Tell me what you") && !transcript.includes("I’m Smithers"),
		transcript === null ? "no transcript" : "no welcome message under the auth message",
	);
	check(
		"zero console errors on the signed-out chat",
		consoleErrors.length === 0,
		consoleErrors.length === 0 ? "console is clean" : consoleErrors.join(" | "),
	);
};

const local = async (): Promise<void> => {
	console.log("building the SPA (vite build)...");
	const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
	if ((await build.exited) !== 0) process.exit(1);

	const identity = createStubIdentity(
		// `wrangler dev` rewrites request URLs to the route in wrangler.jsonc, so
		// the Worker's proxy states http://<route host> to the siblings, not
		// localhost — list it like the real workers' ALLOWED_ORIGINS would.
		await (async (): Promise<ReadonlyArray<string>> => {
			const config = await Bun.file(new URL("../../server/wrangler.jsonc", import.meta.url)).text();
			const host = /"pattern"\s*:\s*"([^"/]+)"/.exec(config)?.[1];
			return host === undefined ? [] : [`http://${host}`];
		})(),
	);
	// Only the identity seam is configured: the signed-out landing is the state
	// under test, and every other seam stays honestly unconfigured.
	const sealed: Record<string, string> = {
		IDENTITY_UPSTREAM_URL: `http://127.0.0.1:${identity.port}`,
		IDENTITY_SERVICE_TOKEN: "",
		IDENTITY_ADMIN_TOKEN: "",
		BILLING_UPSTREAM_URL: "",
		BILLING_AUTH_TOKEN: "",
		BILLING_ADMIN_TOKEN: "",
		RECO_UPSTREAM_URL: "",
		RECO_ADMIN_TOKEN: "",
		GATEWAY_UPSTREAM_URL: "",
		GATEWAY_AUTH_TOKEN: "",
		GATEWAY_SESSION_USER_ID: "",
		SMITHERS_CHAT_AUTH_TOKEN: "",
		SMITHERS_CHAT_URL: "",
	};
	const wrangler = Bun.spawn(
		[
			"bun",
			"x",
			"wrangler",
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			String(WORKER_PORT),
			...Object.entries(sealed).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
		],
		// The Worker and its wrangler.jsonc live in the sibling `smithers-server`
		// package; the config's `main` and `assets.directory` are relative to it.
		{ cwd: fileURLToPath(new URL("../../server/", import.meta.url)), stdout: "inherit", stderr: "inherit" },
	);
	const cleanup = (code: number): never => {
		wrangler.kill();
		identity.stop();
		process.exit(code);
	};
	let up = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(WORKER_ORIGIN);
			if (response.ok) {
				up = true;
				break;
			}
		} catch {
			// wrangler is still starting.
		}
		await wait(500);
	}
	if (!up) {
		console.error("FAIL: wrangler dev never came up.");
		cleanup(1);
	}

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const consoleErrors = collectConsoleErrors(page);
	await page.goto(WORKER_ORIGIN);
	await checkSignedOutChat(page, consoleErrors);
	if (failures > 0) {
		await browser.close();
		cleanup(1);
	}
	await browser.close();
	console.log("\nLOCAL HEADLESS CHECK PASS: signed-out chat (one page), zero console errors.");
	cleanup(0);
};

/* -------------------------------- live mode ------------------------------- */

const LIVE_ORIGIN = "https://canary.smithers.sh";

const live = async (): Promise<void> => {
	const outDir =
		process.argv[3] ??
		`reports/live-checks/${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}`;
	mkdirSync(outDir, { recursive: true });

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const consoleErrors = collectConsoleErrors(page);
	await page.goto(LIVE_ORIGIN);
	await checkSignedOutChat(page, consoleErrors);
	await page.screenshot({ path: `${outDir}/signed-out-chat.png`, fullPage: true });

	// (b) The sign-in click must never dead-end. Two honest live states:
	// OAuth configured upstream → the seam passes the redirect through and the
	// browser lands on github.com's authorize page; unconfigured/erroring →
	// the branded honest page. (During wave 8 the upstream was switched on
	// mid-run, so the happy path is what the click exercises now.)
	const [navigation] = await Promise.all([
		page.waitForNavigation({ waitUntil: "load" }),
		page.click('[data-command="auth.sign-in"]'),
	]);
	const landedUrl = page.url();
	const onGithub = new URL(landedUrl).hostname === "github.com";
	const bodyText = (await page.textContent("body")) ?? "";
	const onHonestPage = bodyText.includes("GitHub sign-in isn't switched on yet for this preview.");
	check(
		"(b) sign-in click never dead-ends (github.com authorize when OAuth is on, branded honest page when off)",
		onGithub || onHonestPage,
		`landed on ${landedUrl} (HTTP ${navigation?.status() ?? "?"})`,
	);

	// The honest page itself, exercised against a REAL upstream error: a
	// callback with a bogus code/state fails the token exchange upstream, and
	// the seam must render the human page — never raw JSON — status preserved.
	const errorNav = await page.goto(`${LIVE_ORIGIN}/api/auth/github/callback?code=bogus&state=bogus`);
	const errorStatus = errorNav?.status() ?? 0;
	const errorBody = (await page.textContent("body")) ?? "";
	check(
		"(b) a failed callback renders the branded honest page, status preserved",
		errorStatus >= 400 &&
			errorStatus < 600 &&
			errorBody.includes("GitHub sign-in didn't finish.") &&
			errorBody.includes(`HTTP ${errorStatus}`),
		`HTTP ${errorStatus}, page says what happened`,
	);
	const homeLink = await page.textContent("a.home");
	check("(b) the page offers the one way back home", homeLink?.includes("Back to Smithers") === true, homeLink ?? "(no link)");
	await page.screenshot({ path: `${outDir}/signin-honest-page.png`, fullPage: true });

	// The way home actually works: back into the chat, still zero console errors.
	const errorsBeforeReturn = consoleErrors.length;
	await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("a.home")]);
	await page.waitForSelector('[data-command="auth.sign-in"]', { timeout: 30_000 });
	check(
		"(b) the way back home lands in the chat (which exists for signed-out users)",
		((await page.textContent(".smithers-transcript")) ?? "").includes(LANDING_SENTENCE),
		"chat re-rendered with the opening sign-in message",
	);
	check(
		"(b) still zero console errors after the round trip",
		consoleErrors.length === errorsBeforeReturn,
		consoleErrors.length === errorsBeforeReturn ? "console is clean" : consoleErrors.slice(errorsBeforeReturn).join(" | "),
	);

	// (c) Machine callers keep the machine answer: the same failed callback
	// with Accept: application/json gets the upstream's JSON, status intact.
	const machine = await fetch(`${LIVE_ORIGIN}/api/auth/github/callback?code=bogus&state=bogus`, {
		headers: { accept: "application/json" },
		redirect: "manual",
	});
	const machineType = machine.headers.get("content-type") ?? "";
	check(
		"(c) Accept: application/json still gets the JSON",
		machine.status === errorStatus && machineType.includes("application/json"),
		`HTTP ${machine.status} ${machineType}`,
	);

	await browser.close();
	if (failures > 0) {
		console.log(`\nLIVE HEADLESS CHECK FAILED: ${failures} check(s). Screenshots in ${outDir}/`);
		process.exit(1);
	}
	console.log(`\nLIVE HEADLESS CHECK PASS: screenshots in ${outDir}/`);
	process.exit(0);
};

if (mode === "local") {
	await local();
} else {
	await live();
}
