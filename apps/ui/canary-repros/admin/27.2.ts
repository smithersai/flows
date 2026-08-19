/*
 * Repro — checklist row 27.2 ("First launch: window size, title, and icon are
 * right") for the Electrobun desktop build.
 *
 * The produced app bundle declares `CFBundleIconFile: AppIcon` in Info.plist,
 * but `Contents/Resources/` contains no icon file of any kind — no `.icns`, no
 * `AppIcon` — so macOS falls back to the generic application icon in the Dock,
 * the Finder, and the ⌘-Tab switcher.
 *
 * Window size (1180x800) and title ("Smithers") are declared in
 * `apps/ui/src/bun/index.ts`; they could not be verified visually on this
 * machine (see 27.2.md), so this repro asserts only the icon, which is a
 * checkable property of the built artifact.
 *
 *   bun 27.2.ts
 *   exit 1 while the bug is present, 0 once the bundle ships an icon.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP = "/Users/williamcory/flows/flows/apps/ui/build/canary-macos-arm64/Smithers-canary.app";
const RESOURCES = join(APP, "Contents/Resources");
const PLIST = join(APP, "Contents/Info.plist");

if (!existsSync(PLIST)) {
	console.error(`SETUP: no build at ${APP}. Run: cd apps/ui && bun run build:canary`);
	process.exit(2);
}

const plist = readFileSync(PLIST, "utf8");
const declared = /<key>CFBundleIconFile<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
const title = /<key>CFBundleName<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
console.log("Info.plist CFBundleName    :", title);
console.log("Info.plist CFBundleIconFile:", declared);

const resources = readdirSync(RESOURCES);
console.log("Contents/Resources         :", resources.join(", "));
const iconFiles = resources.filter((name) => /\.icns$/i.test(name) || /icon/i.test(name) || name === declared);
console.log("icon files present         :", iconFiles.length === 0 ? "(none)" : iconFiles.join(", "));

if (declared !== null && iconFiles.length === 0) {
	console.error(
		`FAIL: Info.plist declares CFBundleIconFile "${declared}" but Contents/Resources ships no icon — macOS renders the generic app icon.`,
	);
	process.exit(1);
}
console.log("PASS — the bundle ships the icon it declares.");
