/*
 * Checklist §15.7 — `/env.set` with a malformed argument.
 *
 * `EnvironmentSeam.parseAssignment` returns the refusal string ("env.set needs
 * a NAME=value pair"), but a slash flow submitted from the composer goes
 * through `AppController.send`, which calls `commands.run` WITHOUT
 * `surfaceCommandFailure`. The refusal is dropped: no card, no message, no
 * toast.
 *
 * Exits non-zero while the bug is present.
 */
import { open, runFlow, cards, transcript } from "./_lib.ts";

const MALFORMED = "/env.set oops-no-equals codeplanesmithers/canary-sandbox";

const { context, page } = await open();
const beforeCards = await cards(page);
const beforeText = await transcript(page);
await runFlow(page, MALFORMED);
await page.waitForTimeout(20_000);
const newCards = (await cards(page)).filter((card) => !beforeCards.includes(card));
const newText = (await transcript(page)).slice(beforeText.length).trim();
const toasts = await page.evaluate(() =>
	Array.from(document.querySelectorAll("[data-toast], .toast, [role=status], [role=alert]")).map(
		(element) => (element.textContent ?? "").trim(),
	),
);
await page.screenshot({ path: "/tmp/canary-repro-15.7.png", fullPage: true });
await context.close();

console.log("new cards:", JSON.stringify(newCards));
console.log("appended text:", JSON.stringify(newText));
console.log("toasts:", JSON.stringify(toasts));

if (newCards.length === 0 && newText === "" && toasts.every((toast) => toast === "")) {
	console.error("FAIL 15.7: a malformed /env.set said nothing at all.");
	process.exit(1);
}
console.log("PASS 15.7: the malformed argument was refused out loud.");
