/*
 * Repro for MANUAL-REVIEW-CHECKLIST row 8.21 (`keys` card) on
 * https://canary.smithers.sh.
 *
 * `/keys.list` reads GET /api/user/byok-keys (see
 * apps/ui/src/mainview/state/seams/KeysSeam.ts, BYOK_KEYS_PATH). The product
 * Worker (apps/server/src/index.ts) implements no /api/user/* route, so the
 * request falls through to the assets binding and comes back as the plain-text
 * "404 page not found". The flow reports "/keys.list didn't run — 404 page not
 * found" and no `keys` card is ever produced, on this deployment or any other.
 *
 * Exits non-zero while the route is missing.
 *
 *   bun apps/ui/canary-repros/cards/8.21.ts
 */
import { chromium } from "playwright";

const BASE = process.env.CANARY_URL ?? "https://canary.smithers.sh";
const PROFILE = process.env.CARDS_PROFILE ?? "/tmp/canary-cards-profile";

const context = await chromium.launchPersistentContext(PROFILE, {
	headless: true,
	viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

const route = await page.evaluate(async () => {
	const response = await fetch("/api/user/byok-keys");
	return { status: response.status, body: (await response.text()).slice(0, 120) };
});
console.log(`GET /api/user/byok-keys -> HTTP ${route.status} ${JSON.stringify(route.body)}`);

const before = await page.locator("body").innerText();
const composer = page.locator("textarea").first();
await composer.click();
await composer.fill("");
await page.keyboard.type("/keys.list", { delay: 8 });
await page.keyboard.press("Enter");
await page.waitForTimeout(9000);

const cards = await page.$$eval('[data-kind="keys"]', (nodes) => nodes.length);
const delta = (await page.locator("body").innerText()).replace(before, "").trim();
console.log(`keys cards rendered: ${cards}`);
console.log(`transcript said: ${JSON.stringify(delta.slice(0, 200))}`);

await page.screenshot({ path: "/tmp/canary-cards-8.21-keys.png", fullPage: true });
await context.close();

if (cards === 0) {
	console.error(
		`FAIL 8.21: no keys card — GET /api/user/byok-keys answers HTTP ${route.status}; the product Worker implements no /api/user/* route.`,
	);
	process.exit(1);
}
console.log("PASS 8.21: the keys card rendered.");
