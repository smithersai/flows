/*
 * The bundling stand-in for `@tanstack/react-start/server-entry`.
 *
 * The Worker's asset fallback dynamically imports the Start server entry only
 * when Vite's Cloudflare Start build defines `__SMITHERS_START__` — but a
 * plain `wrangler dev`/`deploy` still RESOLVES the import at bundle time, and
 * Start's virtual modules (`#tanstack-start-entry`, the manifest) exist only
 * inside that Vite build. wrangler.jsonc aliases the specifier here so the
 * plain Worker bundles; the guard keeps this code path unreachable at runtime,
 * and the 501 below is the honest answer if that ever stops being true.
 */
export default {
	fetch: (): Response =>
		new Response("The Start SSR entry is not part of this Worker build.", { status: 501 }),
};
