/*
 * Vendors the @smthrs dependency closure from the sibling checkouts into
 * vendor/smthrs/<name>, and rewrites package.json deps + overrides to point at
 * the vendored copies (DESIGN.md §14 dependency law).
 *
 * Why vendoring and not file: links to the siblings: Bun installs file: deps
 * as symlinks, so a linked package resolves `effect` from ITS repo's
 * node_modules — two effect instances load, and identity-keyed features
 * (Redacted's registry, context references) break across them. Vendored
 * copies live inside this repo, so every module resolves the one mvp effect.
 * Vendoring also pins the moving sibling trees to a reviewed commit: rerun
 * this script to re-sync deliberately; the diff is the review.
 *
 * Usage: bun scripts/vendor-smthrs.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOTS = [
	{ repo: "/Users/williamcory/flows/agent", packages: "/Users/williamcory/flows/agent/packages" },
	{ repo: "/Users/williamcory/flows/flows", packages: "/Users/williamcory/flows/flows/packages" },
];

/** The packages mvp imports directly; the closure grows from here. */
const DIRECT = ["@smthrs/chain", "@smthrs/model", "@smthrs/kernel"];

const projectRoot = join(import.meta.dir, "..");
const vendorRoot = join(projectRoot, "vendor", "smthrs");

const packageIndex = new Map();
for (const root of ROOTS) {
	for (const dir of readdirSync(root.packages)) {
		const manifestPath = join(root.packages, dir, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (typeof manifest.name === "string" && !packageIndex.has(manifest.name)) {
			packageIndex.set(manifest.name, { dir: join(root.packages, dir), manifest, repo: root.repo });
		}
	}
}

const closure = new Map();
const queue = [...DIRECT];
while (queue.length > 0) {
	const name = queue.pop();
	if (closure.has(name)) continue;
	const found = packageIndex.get(name);
	if (found === undefined) throw new Error(`cannot resolve ${name} in any sibling checkout`);
	closure.set(name, found);
	for (const dep of Object.keys(found.manifest.dependencies ?? {})) {
		if (dep.startsWith("@smthrs/")) queue.push(dep);
	}
}

rmSync(vendorRoot, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });

const vendored = {};
for (const [name, source] of [...closure.entries()].sort(([a], [b]) => a.localeCompare(b))) {
	const short = name.slice("@smthrs/".length);
	const target = join(vendorRoot, short);
	mkdirSync(target, { recursive: true });
	for (const entry of ["package.json", "src", "LICENSE", "README.md", "prompts", "migrations"]) {
		const from = join(source.dir, entry);
		if (existsSync(from)) cpSync(from, join(target, entry), { recursive: true });
	}
	vendored[name] = `file:vendor/smthrs/${short}`;
}

/*
 * Rewrite each vendored manifest's own @smthrs specs ("*" ranges and
 * file:../flows paths from the source monorepos) to vendor-sibling paths, so
 * bun install resolves the whole closure inside this repo. Runtime resolution
 * is top-level either way: every closure member is a direct dependency below.
 */
for (const [name] of closure) {
	const short = name.slice("@smthrs/".length);
	const manifestPath = join(vendorRoot, short, "package.json");
	const packageManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	for (const dep of Object.keys(packageManifest.dependencies ?? {})) {
		if (dep.startsWith("@smthrs/")) {
			packageManifest.dependencies[dep] = `file:../${dep.slice("@smthrs/".length)}`;
		}
	}
	delete packageManifest.devDependencies;
	writeFileSync(manifestPath, `${JSON.stringify(packageManifest, null, "\t")}\n`);
}

const commitOf = (repo) => execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim();
writeFileSync(
	join(vendorRoot, "MANIFEST.json"),
	`${JSON.stringify(
		{
			vendoredAt: new Date().toISOString(),
			sources: Object.fromEntries(ROOTS.map((root) => [root.repo, commitOf(root.repo)])),
			packages: Object.keys(vendored).sort(),
		},
		null,
		"\t",
	)}\n`,
);

/*
 * Every closure member becomes a DIRECT dependency: the vendored dirs are
 * symlinked into node_modules, and module resolution walks their real path
 * (vendor/smthrs/<name>) up to the project root — only top-level entries are
 * visible from there. The published 0.33.0 @smthrs family (@smthrs/ui's tree)
 * shares no name with this closure, so both coexist without overrides.
 */
const manifestPath = join(projectRoot, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
delete manifest.overrides;
for (const dep of Object.keys(manifest.dependencies)) {
	if (dep.startsWith("@smthrs/") && !(dep in vendored) && dep !== "@smthrs/ui") {
		delete manifest.dependencies[dep];
	}
}
for (const [name, spec] of Object.entries(vendored)) manifest.dependencies[name] = spec;
manifest.dependencies = Object.fromEntries(
	Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

console.log(`vendored ${closure.size} packages into vendor/smthrs`);
