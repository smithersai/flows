import { chromium, type BrowserContext, type Page } from "playwright";

const origin = "https://canary.smithers.sh";
const browser = await chromium.launch({ headless: true });
const report: Record<string, unknown> = {};

async function newPage(options: Parameters<typeof browser.newContext>[0] = {}) {
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
	const page = await context.newPage();
	await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
	await page.waitForTimeout(1_000);
	return { context, page };
}

async function command(commandText: string) {
	const { context, page } = await newPage();
	const composer = page.getByRole("textbox", { name: /Message Smithers|Chat message/ });
	await composer.fill(commandText);
	await composer.press("Enter");
	await page.waitForTimeout(3_000);
	const result = {
		body: (await page.locator("body").innerText()).slice(0, 8000),
		theme: await page.locator("html").getAttribute("data-theme"),
		flows: await page.locator("[data-flow]").count(),
		registry: await page.locator("[data-flows]").getAttribute("data-flows").catch(() => null),
	};
	await context.close();
	return result;
}

report.themeCommand = await command("/theme");
report.darkModeCommand = await command("/dark-mode");

for (const mode of ["light", "dark"] as const) {
	const { context, page } = await newPage({ colorScheme: mode });
	const axeSource = await (await fetch("https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js")).text();
	await page.addScriptTag({ content: axeSource });
	const axe = await page.evaluate(async () => {
		const result = await (globalThis as any).axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
		return result.violations.map((violation: any) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })),
		}));
	});
	report[`mode-${mode}`] = {
		htmlTheme: await page.locator("html").getAttribute("data-theme"),
		colorScheme: await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
		contrastViolations: axe,
	};
	await page.screenshot({ path: `/tmp/round3-appearance-${mode}.png`, fullPage: true });
	await context.close();
}

{
	const { context, page } = await newPage();
	const tabStops: unknown[] = [];
	for (let index = 0; index < 14; index += 1) {
		await page.keyboard.press("Tab");
		tabStops.push(await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el) return null;
			const style = getComputedStyle(el);
			return {
				tag: el.tagName,
				name: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 100),
				outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
				boxShadow: style.boxShadow,
				visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
			};
		}));
		if (index === 0) await page.screenshot({ path: "/tmp/round3-appearance-focus.png" });
	}
	report.tabStops = tabStops;

	await page.getByRole("button", { name: /Select a repo|Connect a repository|Surfaces/ }).first().click();
	const menuOpen = (await page.locator("body").innerText()).slice(0, 3000);
	await page.keyboard.press("Escape");
	const menuAfterEscape = (await page.locator("body").innerText()).slice(0, 3000);
	report.escapeMenu = { menuOpen, menuAfterEscape };

	const beforeShortcut = await page.locator("body").innerText();
	await page.keyboard.press("Control+Shift+D");
	await page.waitForTimeout(300);
	const afterShortcut = await page.locator("body").innerText();
	report.nonAdminDevtoolsShortcut = { changed: beforeShortcut !== afterShortcut, after: afterShortcut.slice(0, 3000) };

	report.accessibilityDom = await page.evaluate(() => ({
		conversationLogs: [...document.querySelectorAll<HTMLElement>('[role="log"],[role="region"][aria-label="Conversation messages"]')].map((el) => ({ role: el.getAttribute("role"), label: el.getAttribute("aria-label"), text: el.innerText.slice(0, 300) })),
		liveRegions: [...document.querySelectorAll<HTMLElement>("[aria-live]")].map((el) => ({ live: el.getAttribute("aria-live"), text: el.innerText.slice(0, 300) })),
		composer: [...document.querySelectorAll<HTMLElement>('input[aria-label="Message Smithers"],textarea[aria-label="Message Smithers"],textarea[aria-label="Chat message"]')].map((el) => ({ tag: el.tagName, label: el.getAttribute("aria-label") })),
		unnamedButtons: [...document.querySelectorAll<HTMLButtonElement>("button")].filter((el) => !(el.innerText || el.getAttribute("aria-label"))).length,
	}));
	await context.close();
}

{
	const { context, page } = await newPage();
	let activated = "";
	for (let index = 0; index < 12; index += 1) {
		await page.keyboard.press("Tab");
		const name = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			return (el?.innerText || el?.getAttribute("aria-label") || "").trim();
		});
		const flow = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.flow ?? "");
		if (flow === "auth.sign-in") {
			activated = name;
			await page.keyboard.press("Enter");
			break;
		}
	}
	await page.waitForTimeout(700);
	let oauthActivated = "";
	for (let index = 0; index < 16; index += 1) {
		await page.keyboard.press("Tab");
		const name = await page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			return (el?.innerText || el?.getAttribute("aria-label") || "").trim();
		});
		const flow = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.flow ?? "");
		if (flow === "auth.sign-in") {
			oauthActivated = name;
			await page.keyboard.press("Enter");
			break;
		}
	}
	await page.waitForTimeout(3_000);
	report.keyboardFirstRun = {
		activated,
		oauthActivated,
		url: page.url().replace(/([?&]state=)[^&]+/, "$1<redacted>"),
		body: (await page.locator("body").innerText()).slice(0, 5000),
	};
	await context.close();
}

for (const layout of [
	{ name: "zoom200", width: 1440, height: 1000, zoom: "2" },
	{ name: "phone", width: 390, height: 844, zoom: "1" },
] as const) {
	const { context, page } = await newPage({ viewport: { width: layout.width, height: layout.height } });
	if (layout.zoom !== "1") await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom; }, layout.zoom);
	await page.waitForTimeout(300);
	const clipping = await page.evaluate(() => {
		const viewport = { width: innerWidth, height: innerHeight };
		const candidates = [...document.querySelectorAll<HTMLElement>("button,input,textarea,select,[role=button],[tabindex]")]
			.filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
			.map((el) => {
				const rect = el.getBoundingClientRect();
				return {
					name: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80),
					rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
					clipped: rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight,
				};
			});
		return { viewport, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, candidates };
	});
	report[layout.name] = clipping;
	await page.screenshot({ path: `/tmp/round3-appearance-${layout.name}.png`, fullPage: true });
	await context.close();
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
