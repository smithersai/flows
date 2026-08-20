/*
 * The architecture-law gate (apps/ui/AGENTS.md).
 *
 * Two of this package's laws are invisible at review time — they are about what
 * ISN'T in the source — so they were broken twice by agents who read the file
 * list and not the file. Both are now enumerated from the tree rather than
 * listed here, so a new file that breaks one fails this suite instead of
 * shipping:
 *
 *   1. No React `useEffect` in application code. Derive during render, update
 *      on events, or take a focused subscription hook. An outside-press
 *      dismissal is an EVENT — App.tsx handles it with one capture-phase
 *      handler on the shell root.
 *   2. Network only through seams. Every request the app makes is issued from
 *      `state/seams/`, so there is one directory that answers "what does this
 *      app talk to".
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainviewRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every application source file under src/mainview — tests excluded, tree-derived. */
const applicationFiles = (): ReadonlyArray<string> =>
	readdirSync(mainviewRoot, { recursive: true, encoding: "utf8" })
		.map((entry) => entry.split("\\").join("/"))
		.filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
		.filter((entry) => !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx"))
		.filter((entry) => !entry.endsWith(".gen.ts") && !entry.endsWith(".d.ts"))
		.sort();

const read = (relative: string): string => readFileSync(`${mainviewRoot}${relative}`, "utf8");

/*
 * A guard on the guard: an import rename or a moved directory that emptied this
 * list would make every assertion below vacuous.
 */
describe("architecture laws", () => {
	test("finds the application source to scan", () => {
		const files = applicationFiles();
		expect(files.length).toBeGreaterThan(40);
		expect(files).toContain("App.tsx");
		expect(files).toContain("state/AppController.ts");
	});

	test("no application file uses React useEffect", () => {
		const offenders = applicationFiles().filter((file) => /\buseEffect\b\s*[(<]/.test(read(file)));
		expect(offenders).toEqual([]);
	});

	test("no application file imports useEffect", () => {
		const offenders = applicationFiles().filter((file) =>
			/import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*"react"/.test(read(file)),
		);
		expect(offenders).toEqual([]);
	});

	test("every fetch call site lives in state/seams", () => {
		/*
		 * `ctx.http(…)`/`seam.fetch(…)` are the tapped transports the seams
		 * themselves hand around, so only a BARE `fetch(` — the global — counts
		 * as a call site here.
		 */
		const offenders = applicationFiles()
			.filter((file) => !file.startsWith("state/seams/"))
			.filter((file) => /(^|[^.\w])fetch\s*\(/m.test(read(file)));
		expect(offenders).toEqual([]);
	});

	test("no application file reaches the global transport by another name", () => {
		/*
		 * The bare-`fetch(` scan alone has a hole: `globalThis.fetch` is a
		 * member expression, so it reads as a tapped transport and slips past.
		 * The crash reporter went through that hole. Naming the global at all,
		 * outside the seams, is the violation — whether it is called on the spot
		 * or handed to something else that calls it.
		 */
		const offenders = applicationFiles()
			.filter((file) => !file.startsWith("state/seams/"))
			.filter((file) => /\b(?:globalThis|window|self)\s*\.\s*fetch\b/.test(read(file)));
		expect(offenders).toEqual([]);
	});

	test("the seams directory is where the requests actually are", () => {
		const seams = applicationFiles().filter((file) => file.startsWith("state/seams/"));
		expect(seams.length).toBeGreaterThan(5);
		expect(seams).toContain("state/seams/BootSessionSeam.ts");
		expect(seams).toContain("state/seams/ClientErrorSeam.ts");
	});
});
