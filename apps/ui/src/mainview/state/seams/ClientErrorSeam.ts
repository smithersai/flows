/*
 * The client-error seam: the one request the crash reporter makes.
 *
 * It lives here for the same reason every other request does (the network law,
 * AGENTS.md): one directory answers what this app talks to. Like
 * BootSessionSeam it takes no SeamContext — a reporter that needed a store and
 * a dispatcher could not report the failure that broke them, which is the
 * failure it exists for.
 *
 * `keepalive` is the load-bearing part: a report has to survive the navigation
 * a crash often triggers. The browser allows 64 KiB of keepalive bodies in
 * flight at once, which is four reports at the reporter's cap, and a crashing
 * page sends them one at a time.
 */
export type ClientErrorPost = (input: string, init: RequestInit) => Promise<Response>;

/** POST one client-error report, on the global transport, keepalive included by the caller. */
export const postClientError: ClientErrorPost = (input, init) => fetch(input, init);
