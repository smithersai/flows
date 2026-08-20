/*
 * Wave 13 B-6 — a correction never renders as an error state.
 *
 * The launch-morning sweep watched a correction ("No — I meant the other
 * repo") and found one `[role="alert"]` on screen: not an error at all, but
 * the "Your repositories are ready to choose" toast, rendered by the shared
 * Alert component whose hardcoded role="alert" is an assertive ERROR
 * landmark. A calm notification is a status, not an alert — only a failed
 * toast may claim the alert role. Pinned here at the render boundary.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ToastStack } from "../ToastStack";
import type { Toast } from "./AppState";

GlobalRegistrator.register();

afterAll(async () => {
	for (let tick = 0; tick < 3; tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await GlobalRegistrator.unregister();
});

const mounted: Array<() => void> = [];

afterEach(() => {
	while (mounted.length > 0) mounted.pop()?.();
});

const toast = (id: string, status: Toast["status"]): Toast => ({
	id,
	key: id,
	title: "Your repositories are ready to choose",
	detail: "",
	status,
	createdAt: 1,
	updatedAt: 1,
});

const renderToasts = (toasts: ReadonlyArray<Toast>): HTMLElement => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	flushSync(() => root.render(<ToastStack toasts={toasts} onDismiss={() => {}} />));
	mounted.push(() => {
		flushSync(() => root.unmount());
		host.remove();
	});
	return host;
};

describe("wave 13 B-6 — a notification is a status, never an alert", () => {
	test("running and ok toasts render role=status — no alert surface", () => {
		const host = renderToasts([toast("t1", "running"), toast("t2", "ok")]);
		expect(host.querySelectorAll('[role="alert"]').length).toBe(0);
		expect(host.querySelectorAll('.toast[role="status"]').length).toBe(2);
	});

	test("only a FAILED toast is an alert", () => {
		const host = renderToasts([toast("t1", "ok"), toast("t2", "failed")]);
		expect(host.querySelectorAll('.toast[role="status"]').length).toBe(1);
		expect(host.querySelectorAll('.toast[role="alert"]').length).toBe(1);
	});
});

/*
 * ── Where the stack sits (will, 2026-08-19) ─────────────────────────────────
 *
 * "the toasts are showing up in the bottom right corner of screen when they
 * should be in top right corner of screen."
 *
 * happy-dom does not apply the app's stylesheets, so the placement is pinned
 * at its source. The clearance is not a copy of the number in chat.css: it is
 * recomputed from the two rules that already own that corner, so moving the
 * corner chrome or the pane header without moving the stack fails here rather
 * than on will's screen.
 */

const stylesheet = (name: string): string =>
	readFileSync(fileURLToPath(new URL(`../styles/${name}`, import.meta.url)), "utf8");

const chatCss = stylesheet("chat.css");
const surfacesCss = stylesheet("surfaces.css");
const baseCss = stylesheet("base.css");

/** One rule's declarations, by exact selector, comments stripped. */
const ruleBody = (css: string, selector: string): string => {
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if ((match[1] ?? "").trim() === selector) return match[2] ?? "";
	}
	throw new Error(`Wave13Toasts.test found no rule for ${selector}`);
};

/** A px-valued declaration, or undefined when the rule does not set it. */
const pixels = (body: string, property: string): number | undefined => {
	const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*(-?[\\d.]+)px\\s*;`).exec(body);
	return found === null ? undefined : Number(found[1]);
};

describe("the toast stack hangs from the top-right, clear of what is already there", () => {
	const stack = ruleBody(chatCss, ".toast-stack");

	test("it is anchored to the top edge, not the bottom", () => {
		expect(stack).toContain("position: fixed");
		expect(pixels(stack, "top")).toBeGreaterThan(0);
		expect(pixels(stack, "bottom")).toBeUndefined();
	});

	test("it stays in the right-hand corner", () => {
		expect(pixels(stack, "right")).toBe(16);
		expect(pixels(stack, "left")).toBeUndefined();
	});

	test("it clears the corner chrome and an open pane's header, both of which own that corner", () => {
		const corner = ruleBody(chatCss, ".corner-chrome");
		const control = ruleBody(chatCss, ".app-shell .corner-theme-btn,\n.app-shell .corner-reset-btn");
		const header = ruleBody(surfacesCss, ".surface-header");

		const cornerBottom = (pixels(corner, "top") ?? 0) + (pixels(control, "height") ?? 0);
		const headerBottom = pixels(header, "min-height") ?? 0;
		expect(cornerBottom).toBeGreaterThan(0);
		expect(headerBottom).toBeGreaterThan(0);

		const top = pixels(stack, "top") ?? 0;
		expect(top).toBeGreaterThanOrEqual(Math.max(cornerBottom, headerBottom));
	});

	test("its members enter from above rather than rising from below", () => {
		const toastRule = ruleBody(chatCss, ".toast-stack .toast");
		const animation = /animation:\s*([\w-]+)/.exec(toastRule);
		expect(animation).not.toBeNull();
		const name = animation?.[1] ?? "";
		expect(name).not.toBe("view-in");

		const keyframes = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(baseCss);
		expect(keyframes).not.toBeNull();
		const from = /from\s*\{([\s\S]*?)\}/.exec(keyframes?.[1] ?? "");
		const offset = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(from?.[1] ?? "");
		expect(offset).not.toBeNull();
		expect(Number(offset?.[1] ?? 0)).toBeLessThan(0);
	});
});
