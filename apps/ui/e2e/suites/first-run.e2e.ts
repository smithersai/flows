/*
 * Opt-in persona proofs for checklist states a live GitHub account cannot be
 * reset to. These grade product behaviour only; README policy requires their
 * evidence to be labelled verified-via-mock, never live verification.
 *
 * Claim map (manual checklist row → the E-id this suite prints): the chooser
 * as the one onboarding question (§3.6 → E2.1), the welcome line exactly once
 * (§3.4 → E2.2), the zero-repository honest state (§3.9 → E2.10), the 200+
 * repository chooser (§3.10 → E2.11), the $0 chip and card (§17.2 → E6.1),
 * and $0 pausing only non-complimentary work (§17.5 → E6.2). Every report.ok
 * line leads with its id so the runner's anti-vacuous gate holds this suite to
 * the rows it claims — a browser-less skip reports them unproven instead of
 * passing silently.
 */
import { waitUntil } from "../Assert.ts";
import type { CdpSession } from "../Browser.ts";
import { PERSONAS, type GithubPersona } from "../Personas.ts";
import { defineSuite } from "../Suite.ts";
import {
	INTRO_GRANT_LINE,
	ZERO_BALANCE_PAUSE_COPY,
	sendPrompt,
} from "../../src/launch-checklist/Probes.ts";

const count = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length`;

/*
 * Assertions read the element that owns the claim, never document.body:
 * body innerText lets a balance line pass because the same words rendered in
 * a toast, a chip, or a stale card.
 */
const textOf = (selector: string): string => `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`;
const TRANSCRIPT = ".smithers-transcript";
const BALANCE_CARD = "section.smithers-card[data-kind='balance']";
const CHOOSER_LIST = ".repo-chooser-list";

export default defineSuite({
	id: "persona-first-run",
	title: "opt-in personas cover first-run, repository extremes, and zero balance",
	browser: true,
	order: 95,
	run: async ({ stack, report, browser }) => {
		let active: CdpSession | undefined;
		const closeActive = async (): Promise<void> => {
			if (active === undefined) return;
			await active.send("Page.close").catch(() => undefined);
			active.close();
			active = undefined;
		};
		const openPersona = async (persona: GithubPersona): Promise<CdpSession> => {
			await closeActive();
			await stack.reset();
			const cookie = await stack.signInAs(persona);
			const session = await browser.open(cookie);
			active = session;
			// Each persona is a first launch, not a replay of the preceding tab's
			// locally persisted transcript.
			await session.page.evaluate(`localStorage.clear(); true`);
			await session.page.reload();
			await waitUntil(
				report,
				`${persona.login} never reached a signed-in shell`,
				async () => (await session.page.evaluate<number>(count(".corner-balance-chip"))) === 1,
				30_000,
			);
			return session;
		};
		const openBalance = async (session: CdpSession): Promise<string> => {
			const clicked = await session.page.evaluate<boolean>(`(() => {
	const chip = document.querySelector(".corner-balance-chip");
	if (chip === null) return false;
	chip.click();
	return true;
})()`);
			report.check(clicked, "the balance chip could not be opened");
			await waitUntil(
				report,
				"the balance card never opened",
				async () => (await session.page.evaluate<number>(count(BALANCE_CARD))) === 1,
				15_000,
			);
			return session.page.evaluate<string>(textOf(BALANCE_CARD));
		};

		try {
			const fresh = await openPersona(PERSONAS.fresh);
			await waitUntil(
				report,
				"fresh never rendered the repository chooser",
				async () => (await fresh.page.evaluate<number>(count(".repo-chooser"))) === 1,
				30_000,
			);
			report.equals(
				await fresh.page.evaluate<number>(count("section.smithers-card[data-kind='reco']")),
				0,
				"a never-chosen persona rendered a recommendation instead of the repository chooser",
			);
			const freshBalance = await openBalance(fresh);
			report.includes(freshBalance, INTRO_GRANT_LINE, "the chargeCount=0 welcome line");
			report.ok("E2.1 verified-via-mock: fresh renders the one repository chooser, not a recommendation.");
			report.ok("E2.2 verified-via-mock: fresh's balance card carries the $500 welcome line.");

			const established = await openPersona(PERSONAS.established);
			const establishedBalance = await openBalance(established);
			report.excludes(establishedBalance, "of usage on us", "the established account repeated the welcome grant line");
			report.ok("E2.2 verified-via-mock: established never repeats the first-charge welcome line.");

			const zeroRepos = await openPersona(PERSONAS.zeroRepos);
			await waitUntil(
				report,
				"the zero-repository honest state never rendered",
				async () => /watching no repositories/i.test(await zeroRepos.page.evaluate<string>(textOf(TRANSCRIPT))),
				30_000,
			);
			report.equals(
				await zeroRepos.page.evaluate<number>(count(".repo-chooser")),
				0,
				"zero repositories rendered an empty chooser with controls",
			);
			report.ok("E2.10 verified-via-mock: zero repositories lands on an honest empty state, never an empty chooser.");

			const many = await openPersona(PERSONAS.manyRepos200);
			await waitUntil(
				report,
				"the 205-repository chooser never mounted",
				async () => (await many.page.evaluate<number>(count(".repo-chooser-row"))) === 50,
				30_000,
			);
			for (const expected of [100, 150, 200, 205]) {
				await many.page.evaluate(`(() => {
	const list = document.querySelector(".repo-chooser-list");
	if (list === null) return false;
	list.scrollTop = list.scrollHeight;
	list.dispatchEvent(new Event("scroll", { bubbles: true }));
	return true;
})()`);
				await waitUntil(
					report,
					`the repository chooser did not advance to page ${Math.ceil(expected / 50)}`,
					async () => (await many.page.evaluate<number>(count(".repo-chooser-row"))) >= expected,
					10_000,
				);
			}
			report.includes(await many.page.evaluate<string>(textOf(CHOOSER_LIST)), "many-repos-user/repository-205", "the last paginated repository");
			report.ok("E2.11 verified-via-mock: a 205-repository chooser incrementally paginates to the final row without locking the frame.");

			const zeroBalance = await openPersona(PERSONAS.zeroBalance);
			report.equals(
				await zeroBalance.page.evaluate<string | null>(
					`document.querySelector(".corner-balance-chip")?.getAttribute("data-empty") ?? null`,
				),
				"true",
				"the zero-balance chip was not marked empty",
			);
			const emptyBalance = await openBalance(zeroBalance);
			report.includes(emptyBalance, "Balance is at $0", "the zero-balance card empty state");
			report.ok("E6.1 verified-via-mock: the $0 balance chip and card both render the empty state.");

			stack.chat.script({
				frames: [
					{
						type: "delta",
						kind: "text",
						text: [
							"```flow",
							'await ctx.call("flow.list", {})',
							"return done({ ok: true })",
							"```",
						].join("\n"),
					},
					{ type: "done", reason: "stop" },
				],
			});
			await sendPrompt(zeroBalance.page, "Show my workflows.");
			await waitUntil(
				report,
				"the workflow list never rendered its run action",
				async () => (await zeroBalance.page.evaluate<number>(count("[data-flow='flow.run']"))) > 0,
				20_000,
			);
			report.check(
				await zeroBalance.page.evaluate<boolean>(`(() => {
	const run = document.querySelector("[data-flow='flow.run']");
	if (run === null) return false;
	run.click();
	return true;
})()`),
				"the workflow list run action could not be clicked",
			);
			await waitUntil(
				report,
				"the zero-balance workflow pause never rendered",
				async () => ZERO_BALANCE_PAUSE_COPY.test(await zeroBalance.page.evaluate<string>(textOf(TRANSCRIPT))),
				15_000,
			);
			stack.chat.script({
				frames: [
					{
						type: "delta",
						kind: "text",
						text: [
							"```flow",
							'await ctx.call("say", { text: "Chat is still available." })',
							"return done({ ok: true })",
							"```",
						].join("\n"),
					},
					{ type: "done", reason: "stop" },
				],
			});
			await sendPrompt(zeroBalance.page, "Can I still chat?");
			await waitUntil(
				report,
				"chat did not remain available after the zero-balance pause",
				async () => (await zeroBalance.page.evaluate<string>(textOf(TRANSCRIPT))).includes("Chat is still available."),
				15_000,
			);
			report.ok("E6.2 verified-via-mock: $0 pauses non-complimentary workflow work with the U6 message while chat remains available.");
		} finally {
			await closeActive();
		}
	},
});
