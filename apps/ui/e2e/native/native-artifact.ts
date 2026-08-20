/*
 * E12.5 and E12.6 — `electrobun build --env=canary` produces a launchable,
 * channel-stamped artifact that actually carries the SPA.
 *
 * The trap this script exists to avoid: what is left at
 * build/canary-macos-<arch>/Smithers-canary.app is the SELF-EXTRACTOR, not the
 * app. The CLI tars the real bundle, deletes it, and puts a self-extracting
 * launcher in its place. So "the .app exists" proves nothing about whether the
 * built SPA shipped. The only way to know is to decompress
 * Contents/Resources/<hash>.tar.zst and list it, which is what this does.
 *
 * E12.7 is NOT covered here and cannot be: there is no signing configuration
 * anywhere in this repository. See the note this script prints.
 *
 * The script does not run `vite build`. dist/ is a shared build output; it
 * asserts dist/index.html is present and lets `electrobun build` copy it, the
 * same as build:canary does after vite.
 *
 * Usage:
 *   bun e2e/native/native-artifact.ts            verify an existing build
 *   bun e2e/native/native-artifact.ts --build    build canary first, then verify
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url));
const ELECTROBUN_BIN = join(UI_DIR, "node_modules", ".bin", "electrobun");
const BUILD_TIMEOUT_MS = 900_000;
const MIN_ARTIFACT_BYTES = 1_000_000;

const fail: (message: string) => never = (message) => {
	console.error(`FAIL: native canary artifact — ${message}`);
	process.exit(1);
};

const ok = (message: string): void => {
	console.log(`ok: ${message}`);
};

const readJson = async (path: string): Promise<Record<string, unknown>> => {
	if (!existsSync(path)) fail(`${path} does not exist.`);
	return (await Bun.file(path).json()) as Record<string, unknown>;
};

const runBuild = async (): Promise<void> => {
	const child = Bun.spawn([ELECTROBUN_BIN, "build", "--env=canary"], {
		cwd: UI_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	clearTimeout(timer);
	if (exitCode !== 0) {
		fail(`electrobun build --env=canary exited ${exitCode}.\n${stdout.slice(-4_000)}\n${stderr.slice(-4_000)}`);
	}
	ok("electrobun build --env=canary completed.");
};

const main = async (): Promise<void> => {
	if (process.platform !== "darwin") {
		console.log(
			"SKIP: the canary artifact check runs on macOS only — the electrobun CLI builds for the host " +
				"platform and cannot cross-compile a macOS .app or .dmg from Linux.",
		);
		process.exit(0);
	}
	if (!existsSync(join(UI_DIR, "dist", "index.html"))) {
		fail("apps/ui/dist/index.html is missing. Run `bun run build` first.");
	}
	if (process.argv.includes("--build")) await runBuild();

	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const prefix = `canary-macos-${arch}`;
	const bundle = join(UI_DIR, "build", prefix, "Smithers-canary.app");
	const artifacts = join(UI_DIR, "artifacts");
	if (!existsSync(bundle)) {
		fail(`${bundle} does not exist. Re-run with --build.`);
	}

	const launcher = join(bundle, "Contents", "MacOS", "launcher");
	if (!existsSync(launcher)) fail("the bundle has no Contents/MacOS/launcher.");
	const launcherStat = await stat(launcher);
	if (launcherStat.size === 0) fail("the launcher is empty.");
	// Without the executable bit macOS will not run it, and the .dmg is a dud.
	if ((launcherStat.mode & 0o111) === 0) fail("the launcher is not executable.");
	if (!existsSync(join(bundle, "Contents", "Info.plist"))) fail("the bundle has no Info.plist.");
	ok("the canary bundle carries an executable launcher and an Info.plist.");

	/*
	 * E12.5, at the artifact level: a canary build stamps the canary channel
	 * and a real content hash, so a dev build can never be mistaken for one —
	 * and the updater's channel read has something true to answer with.
	 */
	const metadata = await readJson(join(bundle, "Contents", "Resources", "metadata.json"));
	if (metadata.identifier !== "sh.smithers.app") fail(`identifier is ${String(metadata.identifier)}.`);
	if (metadata.name !== "Smithers") fail(`name is ${String(metadata.name)}.`);
	if (metadata.channel !== "canary") fail(`channel is ${String(metadata.channel)}, not canary.`);
	const hash = metadata.hash;
	if (typeof hash !== "string" || hash === "" || hash === "dev") {
		fail(`hash is ${JSON.stringify(hash)}, not a real content hash.`);
	}
	ok(`the bundle stamps channel canary for sh.smithers.app with content hash ${hash}.`);

	const update = await readJson(join(artifacts, `${prefix}-update.json`));
	if (update.platform !== "macos" || update.arch !== arch) {
		fail(`the update manifest targets ${String(update.platform)}/${String(update.arch)}.`);
	}
	if (update.hash !== hash) {
		fail(`the update manifest hash ${String(update.hash)} does not match the bundle's ${hash}.`);
	}
	if (typeof update.version !== "string" || update.version === "") fail("the update manifest has no version.");
	ok(`the update manifest names version ${update.version} and the same content hash.`);

	const tarZst = join(artifacts, `${prefix}-Smithers-canary.app.tar.zst`);
	const dmg = join(artifacts, `${prefix}-Smithers-canary.dmg`);
	for (const [label, path] of [["tarball", tarZst] as const, ["dmg", dmg] as const]) {
		if (!existsSync(path)) fail(`the ${label} ${path} was not produced.`);
		const size = (await stat(path)).size;
		if (size < MIN_ARTIFACT_BYTES) fail(`the ${label} is only ${size} bytes.`);
	}
	ok("the release tarball and the dmg were both produced at a plausible size.");

	/*
	 * The .app left in build/ is the self-extractor. The real bundle only
	 * exists inside this tarball, so proving the SPA shipped means going
	 * through it. electrobun's own zig-zstd is the decompressor.
	 */
	const electrobunRoot = dirname(dirname(dirname(dirname(Bun.resolveSync("electrobun/bun", UI_DIR)))));
	const zstd = join(electrobunRoot, `dist-macos-${arch}`, "zig-zstd");
	if (!existsSync(zstd)) fail(`${zstd} is missing; cannot inspect the shipped tarball.`);
	const scratch = await mkdtemp(join(tmpdir(), "smithers-artifact-"));
	try {
		const tar = join(scratch, "bundle.tar");
		const decompressed = Bun.spawnSync([zstd, "decompress", "-i", tarZst, "-o", tar]);
		if (decompressed.exitCode !== 0) {
			fail(`zig-zstd could not decompress the shipped tarball: ${decompressed.stderr.toString()}`);
		}
		const listed = Bun.spawnSync(["tar", "-tf", tar]);
		if (listed.exitCode !== 0) fail(`tar could not list the shipped bundle: ${listed.stderr.toString()}`);
		const entries = listed.stdout.toString().split("\n");
		const view = "Smithers-canary.app/Contents/Resources/app/views/mainview/index.html";
		if (!entries.includes(view)) fail(`the shipped tarball does not contain ${view} — the SPA never shipped.`);
		const assets = entries.filter((entry) =>
			entry.startsWith("Smithers-canary.app/Contents/Resources/app/views/mainview/assets/"),
		);
		if (assets.length === 0) fail("the shipped tarball contains no built assets for the main view.");
		ok(`the shipped tarball carries the SPA and ${assets.length} built asset entries.`);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}

	console.log(
		"note: this artifact is UNSIGNED and UNNOTARIZED. build.mac.codesign and build.mac.notarize " +
			"both default to false and electrobun.config.ts overrides neither, so Gatekeeper refuses the " +
			"dmg on any machine that did not build it. E12.7 is a human task — an Apple Developer " +
			"Program membership, a Developer ID Application certificate and notary credentials — not a " +
			"test this repository can make pass.",
	);
	console.log(
		"PASS: native canary artifact — build --env=canary produced a launchable, channel-stamped " +
			"self-extracting bundle, a dmg, a matching update manifest, and a tarball that really carries " +
			"the built SPA.",
	);
	process.exit(0);
};

await main();
