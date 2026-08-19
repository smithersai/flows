/*
 * Repro — checklist row 1.1 ("Load the app signed out. The one offered next
 * step is sign-in; nothing else is presented as available.") against
 * https://canary.smithers.sh.
 *
 * Signed out, the composer still carries the `connect` control. Opening it
 * offers three more next steps — "Connect GitHub…", "Import to Smithers
 * Cloud…" (`repos.import`) and "Open connectors" — and "Open connectors"
 * opens a whole Connectors surface that presents "Connect" and "Import" as
 * available work, plus a "Connected repositories" panel. Sign-in is therefore
 * not the one offered next step.
 *
 *   bun 1.1.ts        exit 1 while the bug is present, 0 once it is fixed.
 */
import { chromium } from "playwright";
import { BASE, PROFILE, report, resetOrigin, session, visibleFlows } from "./_lib";

const context = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 1000 } });
const page = context.pages()[0] ?? (await context.newPage());
await resetOrigin(context, page, { signOut: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

const identity = await session(page);
console.log("session:", JSON.stringify(identity));
if (JSON.stringify(identity) !== '{"status":"signed-out"}') {
	console.error("precondition failed: this repro must run signed out");
	process.exit(2);
}

const failures: Array<string> = [];

const onLoad = await visibleFlows(page);
console.log("flows on the signed-out load:", JSON.stringify(onLoad));
const nonSignIn = onLoad.filter((name) => name !== "auth.sign-in" && name !== "copy-message" && name !== "surfaces");
if (nonSignIn.length > 0) {
	failures.push(`the signed-out load offers more than sign-in: ${nonSignIn.join(", ")}`);
}

await page.locator('[data-flow="connect"]').first().click();
await page.waitForTimeout(1500);
const menu = await page.locator("body").innerText();
for (const item of ["Import to Smithers Cloud", "Open connectors"]) {
	if (menu.includes(item)) failures.push(`the signed-out composer menu presents "${item}" as available`);
}

await page.getByText("Open connectors", { exact: true }).click();
await page.waitForTimeout(4000);
const surface = await page.locator("body").innerText();
console.log("connectors surface text:\n" + surface.slice(surface.indexOf("Connectors")));
await page.screenshot({ path: "/tmp/canary-access-1.1-connectors.png", fullPage: true });
if (surface.includes("Connectors") && surface.includes("Connected repositories")) {
	failures.push("signed out, the Connectors surface opens and presents GitHub Connect / Smithers Cloud Import as available work");
}
const after = await visibleFlows(page);
console.log("flows on the connectors surface:", JSON.stringify(after));
if (after.includes("repos.import")) failures.push("`repos.import` is presented as an available affordance while signed out");

await context.close();
report(failures);
