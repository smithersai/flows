/*
 * The transport seam: the one place in `src/mainview` that names the global
 * `fetch`.
 *
 * The network law (AGENTS.md) says every request this app makes is issued from
 * `state/seams/`, so there is one directory that answers "what does this app
 * talk to". A controller that reaches for the global itself keeps the law's
 * letter — it never writes `fetch(` — while handing the transport to code that
 * does, which is how `fetch.bind(globalThis)` sat in three modules outside this
 * directory and still read as compliant. Acquiring the global is the seam's
 * job; callers take the function from here and inject a double in tests.
 */
import type { FetchLike } from "smithers-shared/NativeAgent";

/**
 * The platform's own transport, bound to the global object.
 *
 * Bound rather than passed by reference because an unbound `fetch` throws
 * `Illegal invocation` the moment it is called with any other receiver.
 */
export const globalTransport = (): FetchLike => fetch.bind(globalThis);
