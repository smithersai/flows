import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Smithers",
		identifier: "sh.smithers.app",
		version: "0.0.1",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			/*
			 * §27.2: the bundle's Info.plist declared CFBundleIconFile "AppIcon"
			 * and shipped no icon, so macOS drew the generic application icon in
			 * the Dock, Finder and Cmd-Tab. `icon.iconset` carries the same mark
			 * the browser tab uses, at every size iconutil asks for.
			 */
			icons: "icon.iconset",
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
