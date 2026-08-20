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

/**
 * Every endpoint constant `source` interpolates into a URL — i.e. every place
 * it BUILDS a request target rather than merely naming a path.
 *
 * `${baseUrl}${WORKFLOW_RPC_PATH}` is a call site; passing the same constant to
 * a seam as an option is not. Reading the parse is what tells them apart.
 */
const interpolatedEndpoints = (file: string, source: string): ReadonlyArray<string> => {
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isTemplateExpression(node)) {
			for (const span of node.templateSpans) {
				if (ts.isIdentifier(span.expression) && span.expression.text.endsWith("_PATH")) {
					found.add(span.expression.text);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return [...found].sort();
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

	test("no new endpoint is addressed from outside the seams", () => {
		/*
		 * A ratchet, not a clean sheet. Moving every request AppController
		 * still issues — auth, billing, reco, admin, the model relay — into
		 * seams is a refactor no directive here opens, so the ones that
		 * predate this law are recorded rather than hidden. The rule is that
		 * this inventory may only SHRINK: an endpoint added to a file outside
		 * `state/seams/` fails here, which is what the Flows tab's provision
		 * and RPC calls would have done.
		 *
		 * `state/controller/*` is an unimported parallel decomposition of the
		 * controller that arrived with the tree; nothing in the app imports it
		 * and it is on no code path. It is listed because it is application
		 * source, not because it talks to anything.
		 */
		const inventory: Record<string, ReadonlyArray<string>> = {};
		for (const file of applicationFiles().filter((entry) => !entry.startsWith("state/seams/"))) {
			const endpoints = interpolatedEndpoints(file, read(file));
			if (endpoints.length > 0) inventory[file] = endpoints;
		}
		expect(inventory).toEqual({
			"native/WebAgent.ts": ["CANCEL_PATH", "TURN_PATH"],
			"state/AppController.ts": [
				"ADMIN_ALLOWLIST_PATH",
				"ADMIN_FEEDBACK_PATH",
				"ADMIN_GRANT_PATH",
				"ADMIN_HEALTH_PATH",
				"ADMIN_REQUESTS_PATH",
				"APPROVAL_DECISION_PATH",
				"AUTH_LOGOUT_PATH",
				"AUTH_NATIVE_CLAIM_PATH",
				"AUTH_NATIVE_START_PATH",
				"AUTH_SCOPES_PATH",
				"AUTH_SESSION_PATH",
				"AUTH_SIGN_IN_PATH",
				"BILLING_BALANCE_PATH",
				"IDENTITY_REQUEST_ACCESS_PATH",
				"MODEL_STREAM_PATH",
				"RECO_FEEDBACK_PATH",
				"RECO_FIRST_RUN_PATH",
				"TOOLS_BROWSER_FETCH_PATH",
				"WORKFLOW_EVENTS_PATH",
				"WORKFLOW_STREAM_PATH",
			],
			"state/controller/auth-billing.ts": [
				"ADMIN_ALLOWLIST_PATH",
				"ADMIN_FEEDBACK_PATH",
				"ADMIN_GRANT_PATH",
				"ADMIN_HEALTH_PATH",
				"ADMIN_REQUESTS_PATH",
				"AUTH_LOGOUT_PATH",
				"AUTH_NATIVE_CLAIM_PATH",
				"AUTH_NATIVE_START_PATH",
				"AUTH_SCOPES_PATH",
				"AUTH_SESSION_PATH",
				"AUTH_SIGN_IN_PATH",
				"BILLING_BALANCE_PATH",
				"IDENTITY_REQUEST_ACCESS_PATH",
			],
			"state/controller/connectors.ts": [
				"RECO_FEEDBACK_PATH",
				"RECO_FIRST_RUN_PATH",
				"RECO_REPOS_PATH",
				"RECO_WATCHED_PATH",
			],
			"state/controller/presentation.ts": ["TOOLS_BROWSER_FETCH_PATH"],
			"state/controller/workflow-pump.ts": ["WORKFLOW_EVENTS_PATH", "WORKFLOW_STREAM_PATH"],
			"state/controller/workflows.ts": [
				"APPROVAL_DECISION_PATH",
				"WORKFLOW_PROVISION_PATH",
				"WORKFLOW_RPC_PATH",
			],
			"state/controller/world.ts": ["MODEL_STREAM_PATH"],
		});
	});

	test("the workspace endpoints are addressed from their own seam", () => {
		/*
		 * Directive 1's Flows tab reads the workspace, and both of its requests
		 * were issued from AppController — the network law's letter kept (the
		 * calls went through the tapped transport) and its point missed. The
		 * constants still reach the controller, because the controller decides
		 * WHICH repository and WHEN; only the seam may turn one into a URL.
		 */
		expect(interpolatedEndpoints("state/AppController.ts", read("state/AppController.ts"))).not.toContain(
			"WORKFLOW_PROVISION_PATH",
		);
		expect(interpolatedEndpoints("state/AppController.ts", read("state/AppController.ts"))).not.toContain(
			"WORKFLOW_RPC_PATH",
		);
		/*
		 * A guard on the guard: deleting the constants would satisfy the two
		 * assertions above and take the feature with them. They must still
		 * reach the controller, which hands them to the seam as options.
		 */
		const controller = read("state/AppController.ts");
		expect(controller).toContain("provisionPath: WORKFLOW_PROVISION_PATH");
		expect(controller).toContain("rpcPath: WORKFLOW_RPC_PATH");
	});

	test("the seams directory is where the requests actually are", () => {
		const seams = applicationFiles().filter((file) => file.startsWith("state/seams/"));
		expect(seams.length).toBeGreaterThan(5);
		expect(seams).toContain("state/seams/BootSessionSeam.ts");
		expect(seams).toContain("state/seams/ClientErrorSeam.ts");
	});
});
