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
 *      app talk to". The global transport itself counts: three modules held
 *      `fetch.bind(globalThis)` and read as compliant to the text scans below,
 *      because binding the global is not calling it. Naming `fetch` is now the
 *      violation, and the scan reads the parsed source rather than the text, so
 *      a comment or a string cannot trip it and a rename cannot hide in one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

/**
 * Every place `source` uses the global `fetch` as a VALUE, as `file:line`.
 *
 * Reads the TypeScript parse rather than the text, so a comment, a string or a
 * property that happens to be spelled `fetch` is not a hit and a bound or
 * aliased global is.
 */
const globalFetchReferences = (file: string, source: string): ReadonlyArray<string> => {
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === "fetch" && !isDeclaredName(node) && !isTypePosition(node)) {
			found.push(`${file}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return found;
};

/** `o.fetch`, `{ fetch: … }`, `(fetch) => …`: a name, not the global. */
const isDeclaredName = (node: ts.Identifier): boolean => {
	const parent = node.parent as ts.Node & { readonly name?: ts.Node };
	if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
	return (
		(ts.isPropertyAssignment(parent) ||
			ts.isShorthandPropertyAssignment(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isMethodSignature(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isParameter(parent) ||
			ts.isBindingElement(parent) ||
			ts.isVariableDeclaration(parent) ||
			ts.isFunctionDeclaration(parent)) &&
		parent.name === node
	);
};

/** `typeof fetch` in a type names the SHAPE of a transport, never one to call. */
const isTypePosition = (node: ts.Identifier): boolean => {
	for (let scope: ts.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
		if (ts.isTypeQueryNode(scope) || ts.isTypeReferenceNode(scope) || ts.isTypeNode(scope)) return true;
		if (ts.isExpression(scope) || ts.isStatement(scope)) return false;
	}
	return false;
};

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

	test("no application file names the global fetch outside the seams", () => {
		/*
		 * The two scans above read TEXT, and both have the same hole: they look
		 * for a shape (`fetch(`, `globalThis.fetch`) rather than for the
		 * identifier. `fetch.bind(globalThis)` is neither shape, so the
		 * controller, the web agent client and the controller context each held
		 * the global and passed every text gate. Handing the transport to
		 * something else that calls it is the same violation as calling it.
		 *
		 * So this one reads the PARSE: every `fetch` identifier that is a value
		 * — not a property name, not a parameter, not the `typeof fetch` in a
		 * type position, which names no transport and issues no request. Only
		 * `state/seams/Transport.ts` and the two request seams that predate it
		 * may hold it.
		 */
		const offenders = applicationFiles()
			.filter((file) => !file.startsWith("state/seams/"))
			.flatMap((file) => globalFetchReferences(file, read(file)));
		expect(offenders).toEqual([]);
	});

	test("the fetch scan reads the parse, not the prose", () => {
		/*
		 * A guard on the guard. The scan is only worth its green if it finds a
		 * bound global, ignores a comment and a string that say "fetch", and
		 * ignores a property that is merely named `fetch`.
		 */
		const offending = 'const t = fetch.bind(globalThis);\n';
		const innocent =
			'// hand the fetch around\n/* the fetch ring */\nconst s = "fetch, fetch.";\nconst o = { fetch: impl };\nconst u = o.fetch;\ntype F = typeof fetch;\n';
		expect(globalFetchReferences("probe.ts", offending)).toEqual(["probe.ts:1"]);
		expect(globalFetchReferences("probe.ts", innocent)).toEqual([]);
	});

	test("the seams directory is where the requests actually are", () => {
		const seams = applicationFiles().filter((file) => file.startsWith("state/seams/"));
		expect(seams.length).toBeGreaterThan(5);
		expect(seams).toContain("state/seams/BootSessionSeam.ts");
		expect(seams).toContain("state/seams/ClientErrorSeam.ts");
	});
});
