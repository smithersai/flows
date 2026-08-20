import type { BootSession } from "./BootSession";

/*
 * The document the server renders before the browser-only controller and its
 * OPFS store can exist, and the fallback React shows while that boot resolves.
 *
 * THE EMBED LAW and NO INVENTION together decide what it may say: nothing.
 * Every sentence the user is owed on arrival — the design-partner preview
 * line, the scopes in plain words, the sign-in action — is already a Smithers
 * message in the chat, with the transcript above it and the composer below
 * (App.tsx's `auth-state` row; AuthChat.test.tsx pins it). Restating that copy
 * on a bare page is a landing takeover with a second sign-in door, and no
 * directive asked for one.
 *
 * So this is the empty mount the app hydrates into. It carries the session the
 * server resolved as a data attribute — state, not copy — and paints no
 * product surface of its own.
 */
export function SessionShell({ session }: { readonly session: BootSession }) {
	return <div className="smithers-app" data-server-session={session.state} />;
}
