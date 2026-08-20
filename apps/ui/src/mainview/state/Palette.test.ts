import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StorageApi } from "@tanstack/db";
import { createAppController } from "./AppController";
import { DEFAULT_PALETTE, PALETTES } from "./AppState";
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge";
import { createAppStore } from "./AppStore";

/*
 * The color-theme axis (/theme), orthogonal to light/dark (/dark-mode). Three
 * halves are pinned here: the store half (the palette is session state with
 * the same persistence every other session field has), the DOM half (the
 * store stamps data-palette on the root element the way it stamps data-theme),
 * and the CSS half (every registered key actually HAS both variants in
 * tokens.css — a key that round-trips into the attribute but matches no block
 * would silently render the default).
 */

GlobalRegistrator.register();

/*
 * bun test shares one process across test files, so the DOM globals registered
 * above would otherwise leak into every file that runs after this one and
 * silently flip `typeof window`/`typeof document` branches (AppStore's theme
 * detection reads both). Registration is confined to this file's run.
 */
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const memoryStorage = (): StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

const unavailableAgent: NativeAgent = {
	available: false,
	startTurn: async () => ({ status: "error", message: "unavailable" }),
	cancelTurn: async () => {},
	subscribe: () => () => {},
};

const unavailableRepositories: NativeRepositories = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error",
		code: "native-required",
		message: "Local repositories can only be connected from the Smithers native app.",
	}),
};

const tokens = readFileSync(fileURLToPath(new URL("../styles/tokens.css", import.meta.url)), "utf8");
const cardsCss = readFileSync(fileURLToPath(new URL("../styles/cards.css", import.meta.url)), "utf8");
const chatCss = readFileSync(fileURLToPath(new URL("../styles/chat.css", import.meta.url)), "utf8");
const surfacesCss = readFileSync(fileURLToPath(new URL("../styles/surfaces.css", import.meta.url)), "utf8");
/** Comments carry braces and selector-looking text, so the block scan reads the code alone. */
const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "");

/** The semantic values a palette owns: everything else in tokens.css derives from these. */
const SEMANTIC_TOKENS = [
	"--bg",
	"--text",
	"--text-muted",
	"--text-faint",
	"--text-placeholder",
	"--surface",
	"--surface-2",
	"--surface-3",
	"--surface-glass",
	"--surface-glass-strong",
	"--border",
	"--border-strong",
	"--border-solid",
	"--hover",
	"--hover-subtle",
	"--inverse-bg",
	"--inverse-text",
	"--brand",
	"--success",
	"--warning",
	"--danger",
	"--info",
	"--code-bg",
	"--code-text",
	"--inline-code-bg",
	"--shadow-rgb",
] as const;

/** The declarations inside the first block whose selector matches exactly. */
const blockFor = (selector: string): string | undefined => {
	for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if ((match[1] ?? "").trim() === selector) return match[2] ?? "";
	}
	return undefined;
};

const declares = (body: string, token: string): boolean =>
	new RegExp(`(^|\\s)${token}\\s*:`, "m").test(body);

describe("the color-theme axis in the store and the DOM", () => {
	test("a fresh session boots on the default palette, stamped beside data-theme", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		expect(store.session().palette).toBe(DEFAULT_PALETTE);
		expect(document.documentElement.dataset.palette).toBe(DEFAULT_PALETTE);
		expect(document.documentElement.dataset.theme).toBe(store.session().theme);
	});

	test("every registered palette round-trips through /theme into the attribute", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, unavailableAgent);
		for (const palette of PALETTES) {
			expect((await controller.commands.run("theme", palette)).status).toBe("executed");
			expect(store.session().palette).toBe(palette);
			expect(document.documentElement.dataset.palette).toBe(palette);
		}
	});

	test("the chosen palette persists across store instances and is re-stamped on boot", async () => {
		const storage = memoryStorage();
		const first = await createAppStore({ kind: "localStorage", storage });
		const transaction = first.dispatch({ type: "palette.changed", actor: "user", palette: "gruvbox" });
		await transaction.isPersisted.promise;
		expect(first.session().palette).toBe("gruvbox");

		document.documentElement.removeAttribute("data-palette");
		const second = await createAppStore({ kind: "localStorage", storage });
		expect(second.session().palette).toBe("gruvbox");
		expect(document.documentElement.dataset.palette).toBe("gruvbox");
	});

	test("the two axes are independent: the light/dark toggle leaves the palette alone", async () => {
		const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
		const controller = createAppController(store, unavailableRepositories, unavailableAgent);
		await controller.commands.run("theme", "catppuccin");
		const before = store.session().theme;
		await controller.commands.run("dark-mode");
		expect(store.session().theme).not.toBe(before);
		expect(store.session().palette).toBe("catppuccin");
		expect(document.documentElement.dataset.palette).toBe("catppuccin");
		expect(document.documentElement.dataset.theme).toBe(store.session().theme);
	});
});

describe("tokens.css carries a full pair of variants for every palette", () => {
	test("the default palette IS :root, in both variants", () => {
		const light = blockFor(":root");
		const dark = blockFor(':root[data-theme="dark"]');
		expect(light).toBeDefined();
		expect(dark).toBeDefined();
		const missing = SEMANTIC_TOKENS.flatMap((token) => [
			...(declares(light ?? "", token) ? [] : [`:root ${token}`]),
			...(declares(dark ?? "", token) ? [] : [`:root[data-theme="dark"] ${token}`]),
		]);
		expect(missing).toEqual([]);
		// night-owl is the default, so it never needs a data-palette block.
		expect(tokens).not.toContain('[data-palette="night-owl"]');
	});

	test("every non-default palette declares the full semantic set in BOTH variants", () => {
		/*
		 * Both blocks must be complete: `:root[data-palette="K"]` and
		 * `:root[data-theme="dark"]` have equal specificity, so a value missing
		 * from a palette's dark block would leak its light value into dark.
		 */
		const missing: Array<string> = [];
		for (const palette of PALETTES) {
			if (palette === DEFAULT_PALETTE) continue;
			const light = blockFor(`:root[data-palette="${palette}"]`);
			const dark = blockFor(`:root[data-palette="${palette}"][data-theme="dark"]`);
			if (light === undefined) missing.push(`${palette}: no light block`);
			if (dark === undefined) missing.push(`${palette}: no dark block`);
			for (const token of SEMANTIC_TOKENS) {
				if (light !== undefined && !declares(light, token)) missing.push(`${palette} light ${token}`);
				if (dark !== undefined && !declares(dark, token)) missing.push(`${palette} dark ${token}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("the bridge and geometry sections stay single and shared", () => {
		// Palette blocks override semantic values only; the bridge derives from
		// them, so a palette that redeclared a bridge token would fork it.
		const bridgeOnly = ["--brand-soft", "--sp-4", "--ctl-h", "--panel", "--font-sans"];
		const forked: Array<string> = [];
		for (const palette of PALETTES) {
			if (palette === DEFAULT_PALETTE) continue;
			const blocks = [
				blockFor(`:root[data-palette="${palette}"]`) ?? "",
				blockFor(`:root[data-palette="${palette}"][data-theme="dark"]`) ?? "",
			];
			for (const body of blocks) {
				for (const token of bridgeOnly) {
					if (declares(body, token)) forked.push(`${palette} redeclares ${token}`);
				}
			}
		}
		expect(forked).toEqual([]);
		expect(tokens.split("--brand-soft:").length - 1).toBe(1);
		expect(tokens.split("--sp-4:").length - 1).toBe(1);
	});
});

/*
 * ── The fill law (will, 2026-08-19) ──────────────────────────────────────────
 *
 * "when I asked it to show repositories it did a great job but the black text
 * on purple is impossible to read."
 *
 * The repo-chooser's selected row filled itself with `var(--accent)`, which
 * aliases `--brand` — the palette's full-saturation colour — and kept `--text`
 * on top of it. That is unreadable in EVERY palette, not only the one will
 * happened to be on, and the same trap sat behind the workflow-repo row and the
 * dev-tools payload blocks.
 *
 * These tests resolve the real declarations out of the real stylesheets, apply
 * the palette cascade the browser applies, and compute WCAG 2.x contrast. They
 * fail if a fill is ever pointed back at a saturated token, and they fail if a
 * new fill forgets to state the foreground it is painting under.
 */

/** Every palette in both variants: the eighteen scopes a fill has to survive. */
const VARIANTS: ReadonlyArray<{ readonly palette: string; readonly theme: "light" | "dark" }> = PALETTES.flatMap(
	(palette) => [
		{ palette, theme: "light" as const },
		{ palette, theme: "dark" as const },
	],
);

/** Custom properties declared by one selector, later declarations winning, as the cascade does. */
const customPropertiesOf = (css: string, selector: string): Map<string, string> => {
	const declared = new Map<string, string>();
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if ((match[1] ?? "").trim() !== selector) continue;
		for (const declaration of (match[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
			declared.set(declaration[1] ?? "", (declaration[2] ?? "").trim());
		}
	}
	return declared;
};

/**
 * The custom properties in force for one palette/theme pair.
 *
 * Layer order is the file's own specificity order: `:root`, then the shared
 * dark block, then the palette's light block, then the palette's dark block.
 */
const scopeFor = (palette: string, theme: "light" | "dark"): Map<string, string> => {
	const layers = [":root", ...(theme === "dark" ? [':root[data-theme="dark"]'] : [])];
	if (palette !== DEFAULT_PALETTE) {
		layers.push(`:root[data-palette="${palette}"]`);
		if (theme === "dark") layers.push(`:root[data-palette="${palette}"][data-theme="dark"]`);
	}
	const scope = new Map<string, string>();
	for (const layer of layers) {
		for (const [name, value] of customPropertiesOf(tokens, layer)) scope.set(name, value);
	}
	return scope;
};

type Rgb = readonly [number, number, number];

const parseColor = (value: string): Rgb => {
	const text = value.trim();
	const short = /^#([0-9a-f]{3})$/i.exec(text);
	if (short !== null) {
		const digits = short[1] ?? "";
		return [0, 1, 2].map((index) => parseInt(`${digits[index]}${digits[index]}`, 16)) as unknown as Rgb;
	}
	const long = /^#([0-9a-f]{6})$/i.exec(text);
	if (long !== null) {
		const digits = long[1] ?? "";
		return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16)) as unknown as Rgb;
	}
	// The alpha channel is dropped: every value these tests read is opaque.
	const channels = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
	if (channels !== null) return [Number(channels[1]), Number(channels[2]), Number(channels[3])] as const;
	throw new Error(`Palette.test cannot read the colour ${JSON.stringify(value)}`);
};

/** `var()`, `color-mix(in srgb, A p%, B)` and literals, resolved the way the browser resolves them. */
const resolveColor = (scope: Map<string, string>, value: string, depth = 0): Rgb => {
	if (depth > 12) throw new Error(`Palette.test looped resolving ${JSON.stringify(value)}`);
	const text = value.trim();
	const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
	if (reference !== null) {
		const next = scope.get(reference[1] ?? "") ?? reference[2];
		if (next === undefined) throw new Error(`Palette.test cannot resolve ${reference[1]}`);
		return resolveColor(scope, next, depth + 1);
	}
	const mixed = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*([\s\S]+?)\s*\)$/.exec(text);
	if (mixed !== null) {
		const first = resolveColor(scope, mixed[1] ?? "", depth + 1);
		const second = resolveColor(scope, mixed[3] ?? "", depth + 1);
		const weight = Number(mixed[2]) / 100;
		return [0, 1, 2].map((index) => first[index] * weight + second[index] * (1 - weight)) as unknown as Rgb;
	}
	return parseColor(text);
};

const relativeLuminance = (rgb: Rgb): number => {
	const [red, green, blue] = rgb.map((channel) => {
		const scaled = channel / 255;
		return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
};

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
const contrast = (foreground: Rgb, background: Rgb): number => {
	const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
	return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
};

/** One declaration, read out of the shipped stylesheet by the rule's selector. */
const declaredBy = (css: string, selector: string, property: "background" | "color"): string | undefined => {
	const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
	let found: string | undefined;
	let matched = false;
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (normalize(match[1] ?? "") !== normalize(selector)) continue;
		matched = true;
		const declaration = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(match[2] ?? "");
		if (declaration !== null) found = (declaration[1] ?? "").trim();
	}
	if (!matched) throw new Error(`Palette.test found no rule for ${selector}`);
	return found;
};

/**
 * An element's settled background and foreground: every rule it matches, in
 * cascade order, the last declaration of each property winning. A fill and the
 * foreground it paints under are frequently written in different rules — the
 * slash menu states its colour once on the base row and tints only the
 * highlighted one — and the pair is what has to be readable, not either half.
 */
const settled = (css: string, rules: ReadonlyArray<string>): { readonly background?: string; readonly color?: string } => {
	let background: string | undefined;
	let color: string | undefined;
	for (const selector of rules) {
		background = declaredBy(css, selector, "background") ?? background;
		color = declaredBy(css, selector, "color") ?? color;
	}
	return { ...(background === undefined ? {} : { background }), ...(color === undefined ? {} : { color }) };
};

/** Every fill that paints text on a non-transparent background of its own, with the rules it matches. */
const FILLS: ReadonlyArray<{ readonly what: string; readonly css: string; readonly rules: ReadonlyArray<string> }> = [
	{
		what: "the repo-chooser's selected row",
		css: cardsCss,
		rules: [".repo-chooser-row", '.repo-chooser-row[data-highlighted="true"]'],
	},
	{
		what: "the workflow picker's selected row",
		css: cardsCss,
		rules: [".workflow-repo-row", '.workflow-repo-row[data-highlighted="true"]'],
	},
	{
		what: "the slash menu's highlighted row",
		css: cardsCss,
		rules: [".slash-menu-item", '.slash-menu-item[data-highlighted="true"]'],
	},
	{ what: "the dev-tools payload block", css: chatCss, rules: [".devtools-toolcalls pre, .devtools-json"] },
];

/**
 * The floor, in two parts.
 *
 * ABSOLUTE — 3.5:1, AA for the 600-weight name these rows lead with. No fill
 * may fall under it in any palette.
 *
 * RELATIVE — a fill may not spend more than 35% of the contrast the same
 * foreground already has on the palette's own `--surface`. This is the part
 * that catches the actual bug: `--accent` kept only 20–25% of it. Two palettes
 * (solarized, whose own body text sits at 5.20:1 light and 4.86:1 dark) have no
 * headroom for a 4.5:1 fill from anyone, so an absolute 4.5 would be a floor
 * the palette itself cannot clear; the relative rule holds the fill to the
 * palette it is in.
 */
const ABSOLUTE_FLOOR = 3.5;
const RETAINED_FLOOR = 0.65;

describe("a fill never costs a palette its readability", () => {
	test("every fill states the foreground it paints under", () => {
		const bare = FILLS.filter((fill) => {
			const rule = settled(fill.css, fill.rules);
			return rule.background === undefined || rule.color === undefined;
		}).map((fill) => fill.what);
		expect(bare).toEqual([]);
	});

	test("no stylesheet fills a surface with a bare var(--accent) again", () => {
		/*
		 * `--accent` is a legacy workflow-UI alias for `--brand` (tokens.css).
		 * Nothing in the product may paint with it: it carries no foreground of
		 * its own and reads as "some safe tint", which is exactly how three rules
		 * came to sit at 1.18:1.
		 */
		const offenders: Array<string> = [];
		for (const [name, css] of [["cards.css", cardsCss], ["chat.css", chatCss], ["surfaces.css", surfacesCss]] as const) {
			css.split("\n").forEach((line, index) => {
				if (/background[^;:]*:\s*[^;]*var\(--accent/.test(line)) offenders.push(`${name}:${index + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});

	test("the palette's own --text on a raw --accent fill is unreadable everywhere — the bug, pinned", () => {
		const readable = VARIANTS.filter(({ palette, theme }) => {
			const scope = scopeFor(palette, theme);
			return contrast(resolveColor(scope, "var(--text)"), resolveColor(scope, "var(--accent)")) >= ABSOLUTE_FLOOR;
		}).map(({ palette, theme }) => `${palette}/${theme}`);
		expect(readable).toEqual([]);
	});

	test("every fill clears the floor in all nine palettes, light and dark", () => {
		const failures: Array<string> = [];
		for (const fill of FILLS) {
			const rule = settled(fill.css, fill.rules);
			for (const { palette, theme } of VARIANTS) {
				const scope = scopeFor(palette, theme);
				const foreground = resolveColor(scope, rule.color ?? "var(--text)");
				const ratio = contrast(foreground, resolveColor(scope, rule.background ?? "var(--surface)"));
				const baseline = contrast(foreground, resolveColor(scope, "var(--surface)"));
				const where = `${fill.what} on ${palette}/${theme}`;
				if (ratio < ABSOLUTE_FLOOR) failures.push(`${where}: ${ratio.toFixed(2)}:1 is under ${ABSOLUTE_FLOOR}:1`);
				if (ratio / baseline < RETAINED_FLOOR) {
					failures.push(
						`${where}: keeps ${Math.round((ratio / baseline) * 100)}% of the ${baseline.toFixed(2)}:1 it has on --surface`,
					);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
