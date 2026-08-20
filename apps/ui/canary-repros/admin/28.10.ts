/*
 * Repro — checklist row 28.10 ("The browser tab title and favicon are right")
 * against https://canary.smithers.sh.
 *
 * The title is right ("Smithers"). There is no favicon at all: the document
 * head declares no `link[rel*=icon]`, and `/favicon.ico` 404s, so every tab
 * shows the browser's default blank page icon.
 *
 *   PROF=/tmp/canary-admin-profile bun 28.10.ts
 *   exit 1 while the bug is present, 0 once a favicon is served.
 */
import { open } from "./_lib";

const { context, page } = await open();
const title = await page.title();
const links = await page.evaluate(() =>
	Array.from(document.querySelectorAll("link[rel*='icon']")).map((link) => ({
		rel: link.getAttribute("rel"),
		href: (link as HTMLLinkElement).href,
	})),
);
const ico = await page.evaluate(async () => {
	const response = await fetch("/favicon.ico");
	return { status: response.status, bytes: (await response.blob()).size };
});
console.log("document.title      :", JSON.stringify(title));
console.log("link[rel*=icon]     :", JSON.stringify(links));
console.log("GET /favicon.ico    :", JSON.stringify(ico));
await context.close();

const failures: Array<string> = [];
if (title !== "Smithers") failures.push(`the tab title is ${JSON.stringify(title)}, not "Smithers".`);
if (links.length === 0 && ico.status !== 200) {
	failures.push("no favicon: the head declares no link[rel*=icon] and GET /favicon.ico is a 404, so the tab shows the browser's default icon.");
}
if (failures.length === 0) {
	console.log("PASS — title and favicon are right.");
	process.exit(0);
}
for (const failure of failures) console.error(`FAIL: ${failure}`);
process.exit(1);
