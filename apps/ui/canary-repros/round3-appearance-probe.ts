import { chromium } from "playwright";

const origin = "https://canary.smithers.sh";
const profile = "/tmp/round3-appearance-profile";
const context = await chromium.launchPersistentContext(profile, {
	headless: true,
	viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(2_000);

const composer = page.getByRole("textbox", { name: "Message Smithers" });
await composer.fill("/theme");
await page.waitForTimeout(500);
console.log("AFTER_FILL", JSON.stringify((await page.locator("body").innerText()).slice(0, 4000)));
await composer.press("Enter");
await page.waitForTimeout(1_500);
console.log("AFTER_ENTER", JSON.stringify((await page.locator("body").innerText()).slice(0, 8000)));

const snapshot = await page.evaluate(() => ({
	url: location.href,
	title: document.title,
	htmlAttrs: Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])),
	bodyText: document.body.innerText,
	flows: [...document.querySelectorAll<HTMLElement>("[data-flow]")].map((el) => ({
		flow: el.dataset.flow,
		tag: el.tagName,
		text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 160),
	})),
	controls: [...document.querySelectorAll<HTMLElement>("button,input,textarea,select,[role=button],[tabindex]")].map((el) => ({
		tag: el.tagName,
		text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 120),
		role: el.getAttribute("role"),
		aria: el.getAttribute("aria-label"),
		tabIndex: el.tabIndex,
		disabled: el.hasAttribute("disabled"),
	})),
	liveRegions: [...document.querySelectorAll<HTMLElement>("[aria-live],[role=status],[role=alert]")].map((el) => ({
		tag: el.tagName,
		role: el.getAttribute("role"),
		live: el.getAttribute("aria-live"),
		text: el.innerText.trim().slice(0, 200),
	})),
}));
console.log(JSON.stringify(snapshot, null, 2));
await page.screenshot({ path: "/tmp/round3-appearance-initial.png", fullPage: true });
await context.close();
