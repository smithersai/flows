/*
 * Row 5.2 — three of the four state-dependent orderings are observable; the
 * `typing -> chat.stop` one is not, because the slash menu is suppressed for
 * the whole time a turn streams.
 *
 *   App.tsx: const slashMatches = slashQuery === undefined || typing ? [] : …
 *
 * `recommendedNames` still returns `["chat.stop"]` while `state.typing`, but no
 * surface renders it: the derived suggestion pill row does not consult
 * `recommendedNames` at all (it branches on signed-out / needs-selection /
 * reco), and the menu is empty. The composer's ■ "Stop generating" button is
 * the only stop affordance offered mid-stream, and it carries no `data-flow`
 * (see 6.1).
 *
 * Exits 1 while the typing branch is unreachable.
 */
import { composer, launch, openSlashMenu, resetStore } from "./_harness";

const harness = await launch();
const { ctx, page } = harness;
await resetStore(harness);

const lead = async (query: string) =>
	page.evaluate(() => {
		const options = Array.from(document.querySelectorAll(".slash-menu [role=option]"));
		return {
			count: options.length,
			first: options[0] ? (options[0].querySelector(".slash-menu-name") as HTMLElement).innerText : null,
			gold: options[0]?.getAttribute("data-gold") ?? null,
			selected: options[0]?.getAttribute("aria-selected") ?? null,
		};
	});

// (a) a recommendation is waiting, on the chat surface -> reco.accept leads
await openSlashMenu(page, "/");
const onChat = await lead("/");
console.log("chat surface, reco waiting :", JSON.stringify(onChat));

// (b) off the chat surface -> chat leads
const box = composer(page);
await box.click();
await box.fill("/world");
await page.keyboard.press("Enter");
await page.waitForTimeout(2200);
await openSlashMenu(page, "/");
const offChat = await lead("/");
console.log("world surface             :", JSON.stringify(offChat));
await composer(page).fill("/chat");
await page.keyboard.press("Enter");
await page.waitForTimeout(2000);

// (c) while a turn streams -> chat.stop should lead
await composer(page).click();
await composer(page).fill("Write a 3000 word essay about the history of bridges, in great detail.");
await page.keyboard.press("Enter");
// Wait for the composer's mid-stream chrome, which is the honest "typing" signal.
const stopSelector = 'button[aria-label="Stop generating"]';
await page.waitForSelector(stopSelector, { timeout: 60_000 });
const streaming = await page.locator(stopSelector).count();
console.log("streaming (Stop generating button present):", streaming === 1);
await openSlashMenu(page, "/");
const whileTyping = await lead("/");
const stopButton = await page.evaluate(() =>
	Array.from(document.querySelectorAll("button"))
		.filter((button) => button.getAttribute("aria-label") === "Stop generating")
		.map((button) => ({ dataFlow: button.getAttribute("data-flow"), text: button.innerText })),
);
console.log("while a turn streams      :", JSON.stringify(whileTyping));
console.log("mid-stream stop affordance:", JSON.stringify(stopButton));
await page.keyboard.press("Escape");
await page.locator(stopSelector).click().catch(() => {});

// (d) signed out -> auth.sign-in leads. Clear only this disposable profile's
// cookies after the signed-in branches have completed.
await ctx.clearCookies();
await page.goto(new URL(BASE).origin, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await openSlashMenu(page, "/");
const signedOut = await lead("/");
console.log("signed out                :", JSON.stringify(signedOut));

await page.screenshot({ path: "/tmp/canary-chat-5.2.png", fullPage: true });
console.log("screenshot: /tmp/canary-chat-5.2.png");

const bug =
	onChat.first !== "/reco.accept" ||
	offChat.first !== "/chat" ||
	whileTyping.count === 0 ||
	whileTyping.first !== "/chat.stop" ||
	signedOut.first !== "/auth.sign-in" ||
	signedOut.gold !== "true" ||
	signedOut.selected !== "true";
console.log(`\nreco waiting  -> reco.accept leads : ${onChat.first === "/reco.accept"}`);
console.log(`off the chat surface -> chat leads : ${offChat.first === "/chat"}`);
console.log(`typing -> chat.stop leads          : ${!bug} (menu items while streaming: ${whileTyping.count})`);
console.log(bug ? "\nFAIL: the typing -> chat.stop ordering never reaches a surface" : "\nOK");
await ctx.close();
process.exit(bug ? 1 : 0);
