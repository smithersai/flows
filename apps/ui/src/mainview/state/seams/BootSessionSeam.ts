/*
 * The boot-session seam: the one same-origin read of `GET /api/auth/session`
 * the document render makes before a controller — and therefore before any
 * other seam — exists.
 *
 * It lives here because of the network law (AGENTS.md): every request this app
 * makes is issued from `state/seams/`, so there is one place to look for what
 * the app talks to. This seam is the odd one: it runs on the server during the
 * document render, so it has no store to dispatch into and no card to write.
 * It carries the caller's cookie and nothing else — the request is the user's,
 * not the deployment's — and it returns the raw Response for
 * `Session.functions.ts` to normalize.
 */
export type BootSessionRequest = (request: Request) => Promise<Response>;

/** Read the session for an in-flight document request, on that request's own cookie. */
export const bootSessionRequest: BootSessionRequest = (request) => {
	const url = new URL("/api/auth/session", request.url);
	const headers = new Headers();
	const cookie = request.headers.get("cookie");
	if (cookie !== null) headers.set("cookie", cookie);
	return fetch(url, { headers });
};
