/*
 * Repro / regression guard — checklist row 1.1 ("Load the app signed out. The
 * one offered next step is sign-in; nothing else is presented as available.")
 * against https://canary.smithers.sh.
 *
 * Round 1 (2026-08-18) FAILED: the signed-out load carried a `connect`
 * affordance whose menu offered three more next steps — "Connect GitHub…",
 * "Import to Smithers Cloud…" (repos.import) and "Open connectors" — and
 * "Open connectors" opened a whole Connectors surface, still signed out,
 * presenting GitHub [Connect], Smithers Cloud repository [Import] and a
 * "Connected repositories" panel.
 *
 * Round 2 (2026-08-19) PASSES: signed out, `connect` opens a one-item menu
 * whose only entry is "Connect GitHub…", carrying data-flow="auth.sign-in".
 * There is no Connectors surface and no `repos.import` to reach.
 *
 * The script now guards that contract: every affordance on the signed-out
 * load must be either sign-in itself or app chrome (send, surfaces,
 * dark-mode, copy-message), the connect menu must offer sign-in and nothing
 * else, and `repos.import` must be unreachable.
 *
 *   bun 1.1.ts        exit 1 if the row regresses, 0 while it holds.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report, resetOrigin, session, visibleFlows } from "./_lib";

/* Chrome, not next steps: they neither claim nor need a session. */
const CHROME = new Set(["copy-message", "surfaces", "send", "dark-mode"]);

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await resetOrigin(context, page, { signOut: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
/* The shell's rendered flows are the load-complete signal — never a blind sleep. */
await page.locator("[data-flow]").first().waitFor({ timeout: 30_000 });

const identity = await session(page);
console.log("session:", JSON.stringify(identity));
if (JSON.stringify(identity) !== '{"status":"signed-out"}') {
	console.error("precondition failed: this repro must run signed out");
	process.exit(2);
}

const failures: Array<string> = [];

const onLoad = await visibleFlows(page);
console.log("flows on the signed-out load:", JSON.stringify(onLoad));
const unexpected = onLoad.filter((name) => name !== "auth.sign-in" && name !== "connect" && !CHROME.has(name));
if (unexpected.length > 0) {
	failures.push(`the signed-out load offers something other than sign-in or chrome: ${unexpected.join(", ")}`);
}

await page.locator('[data-flow="connect"]').first().click();
/* The open menu is the signal that the click landed; a fixed wait raced a slow canary. */
await page.locator('[role="menu"]').first().waitFor({ timeout: 10_000 });
const menuText = await page.locator("body").innerText();
for (const item of ["Import to Smithers Cloud", "Open connectors", "Connected repositories"]) {
	if (menuText.includes(item)) failures.push(`the signed-out connect menu presents "${item}" as available`);
}
const menuFlows = (await visibleFlows(page)).filter((name) => name !== "auth.sign-in" && name !== "connect" && !CHROME.has(name));
console.log("flows with the connect menu open:", JSON.stringify(await visibleFlows(page)));
if (menuFlows.length > 0) {
	failures.push(`the signed-out connect menu offers ${menuFlows.join(", ")} beside sign-in`);
}
if (menuFlows.includes("repos.import")) failures.push("`repos.import` is presented while signed out");

await page.screenshot({ path: "/tmp/canary-access/1.1-connect-menu.png", fullPage: true });
await context.close();
report(failures);
