/*
 * The pre-hydration shell states nothing (THE EMBED LAW, NO INVENTION).
 *
 * The server resolves identity before React hydrates, so it is tempting to
 * render the answer right there: a headline, a sentence about the closed
 * alpha, a sign-in link. That is a landing takeover — a bare page, outside the
 * transcript, with a second sign-in door — and no directive asked for one. The
 * chat already owns every one of those sentences, embedded, with the composer
 * below (AuthChat.test.tsx pins the signed-out message and its `auth.sign-in`
 * action). This suite fails if the shell grows copy again.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BootSession } from "./BootSession";
import { SessionShell } from "./SessionShell";

const sessions: ReadonlyArray<BootSession> = [
	{ state: "signed-out", login: null, allowlisted: false, admin: false, authFailed: false },
	{ state: "signed-out", login: null, allowlisted: false, admin: false, authFailed: true },
	{ state: "signed-in", login: "will", allowlisted: false, admin: false, authFailed: false },
	{ state: "signed-in", login: "will", allowlisted: true, admin: true, authFailed: false },
	{ state: "unavailable", login: null, allowlisted: false, admin: false, authFailed: false },
];

const markupFor = (session: BootSession): string => renderToStaticMarkup(<SessionShell session={session} />);

/** Everything between tags: what a reader would see on the page. */
const visibleText = (markup: string): string => markup.replace(/<[^>]*>/g, "").trim();

describe("the pre-hydration session shell", () => {
	test("renders no user-visible copy in any session state", () => {
		for (const session of sessions) {
			const markup = markupFor(session);
			expect(visibleText(markup)).toBe("");
			// The sentences that belong to the chat, named so a reviewer sees
			// which copy is being kept out rather than a bare regex.
			expect(markup).not.toContain("design-partner preview");
			expect(markup).not.toContain("design partners only");
			expect(markup).not.toContain("identity service");
			expect(markup).not.toContain("Smithers is starting");
		}
	});

	test("opens no second sign-in door outside the transcript", () => {
		for (const session of sessions) {
			const markup = markupFor(session);
			expect(markup).not.toMatch(/<a[\s>]/);
			expect(markup).not.toMatch(/<button[\s>]/);
			expect(markup).not.toMatch(/<form[\s>]/);
			expect(markup).not.toContain("/api/auth/sign-in");
		}
	});

	test("carries the resolved session as state, so the shell hydrates onto it", () => {
		for (const session of sessions) {
			expect(markupFor(session)).toContain(`class="smithers-app" data-server-session="${session.state}"`);
		}
	});
});
