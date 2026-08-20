import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));
const response = await page.goto("https://canary.smithers.sh", { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(1_000);
console.log(JSON.stringify(await page.evaluate(() => ({
	body: document.body.innerText.slice(0, 10000),
	html: Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])),
	flowsRoot: document.querySelector("[data-flows]")?.getAttribute("data-flows") ?? null,
	flows: [...document.querySelectorAll<HTMLElement>("[data-flow]")].map((el) => ({ flow: el.dataset.flow, text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 150), tag: el.tagName })),
	controls: [...document.querySelectorAll<HTMLElement>("button,input,textarea,select,[role=button],[tabindex]")].map((el) => ({ tag: el.tagName, role: el.getAttribute("role"), label: el.getAttribute("aria-label"), placeholder: el.getAttribute("placeholder"), text: el.innerText.trim().slice(0, 150), tabindex: el.tabIndex })),
})), null, 2));
console.log(JSON.stringify({ status: response?.status(), errors }, null, 2));
await browser.close();
