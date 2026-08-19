/*
 * E13.1–E13.5, E14.1, E14.3, E14.5 — accessibility, theming, motion, and the
 * client's behaviour when the network or the deployed bundle misbehaves.
 *
 * Every check here is a browser-level check on purpose. The unit tests that
 * already exist read CSS as text (Palette.test.ts) or drive the store in
 * isolation; neither can see what the rendered tree actually resolves to, and
 * neither can see a focus ring, an emulated media query, or a stream that dies
 * halfway. Those are the failures this file is for.
 *
 * The rows are independent, so the file runs them as independent sections: a
 * failure is recorded and the next row still runs, and the suite fails at the
 * end with every failure in one message. A focus-ring regression used to abort
 * the run at check 5 of 16 and leave four unrelated rows unproven, and a
 * `wrangler dev` reload landing on the sign-in round trip used to abort it at
 * row 3 and leave fifteen. Opening the signed-in page is a section like every
 * other row now, and the requests that reach the stack are retried across a
 * reload. Only connection failures are retried, never an assertion.
 *
 * Four deliberate choices about how the assertions get their teeth:
 *
 *  - E13.4 reads the sentinel colours OUT of `@smthrs/ui/src/tokens.ts` and out
 *    of the app's own stylesheets, instead of hardcoding a violet/zinc list.
 *    A fallback the library adds tomorrow is scanned for tomorrow. A sentinel
 *    that also happens to be a real palette value in EITHER theme is dropped,
 *    because such a value cannot discriminate a leak from correct paint (white
 *    is night-owl's real `--surface` in light and Chrome's field text in dark).
 *  - E13.3 compares ring colours as numbers, not as strings. Chrome serializes
 *    one paint several ways: `rgb()` from a hex token, `color(srgb …)` from a
 *    settled `color-mix`, `oklab(…)` from a box-shadow read while its .15s
 *    transition is still running. The walk also waits that transition out by
 *    watching the element's own animations, not by sleeping a fixed number of
 *    milliseconds.
 *  - E13.3 walks the real tab ring with real key events and reads
 *    `matches(":focus-visible")`. A scripted `.focus()` does not satisfy
 *    Chrome's focus-visible heuristic on a button, so it would report a false
 *    negative. The ring is then proved to be focus-CONDITIONAL by re-reading
 *    the same owner element after a blur: an element painted with a permanent
 *    brand shadow must not pass as "has a focus ring".
 *  - E14.1 drops the turn by truncating the streamed response (the client-side
 *    signature of a dropped connection: EOF with no terminal frame) and by
 *    taking the page offline before a send. CDP's offline emulation does NOT
 *    tear down a response body that is already streaming — measured, not
 *    assumed — so an offline-only test would pass while proving nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SuiteFailure, wait, waitUntil, type Reporter } from "../Assert.ts";
import type { CdpSession } from "../Browser.ts";
import { defineSuite } from "../Suite.ts";
import { hasSmithersMessage } from "../../src/launch-checklist/Probes.ts";

/* -------------------------------------------------------------------------- */
/* The rendered contract (E13.2)                                              */
/* -------------------------------------------------------------------------- */

/**
 * App.tsx:712-716 passes these to ChatTranscript; @smthrs/ui's ChatComposer
 * and ChatMessage supply the rest. Every literal is grepped in the lane report.
 */
const TRANSCRIPT_LABEL = "Conversation";
const PENDING_LABEL = "Smithers is responding";
const TEXTAREA_LABEL = "Chat message";
const SEND_LABEL = "Send message";
const STOP_LABEL = "Stop generating";
const THEME_LABEL = "Toggle light and dark mode";
const BALANCE_LABEL = "Show your balance";
const SURFACES_LABEL = "Surfaces";
const COPY_LABEL = "Copy message";
const RETRY_LABEL = "Retry turn";

/** WebAgent.ts:76 — what the client says when the stream dies with no terminal frame. */
const TRUNCATED_DETAIL = "The response stream ended before Smithers finished the turn.";
/** App.tsx:53 — the note the transcript renders over a failed turn that had started. */
const INTERRUPTED_NOTE = `Turn interrupted — ${TRUNCATED_DETAIL}`;
/** App.tsx:54 — the note when the turn never produced an assistant bubble at all. */
const FAILED_NOTE = "Turn failed";
/** AppStore.ts:514 — the body of the message a never-started turn leaves behind. */
const FAILED_MESSAGE_LEAD = "I couldn't complete that turn.";

/** ChatUpstream's default script says this; the retried turn must carry it. */
const STUB_REPLY = "Hi, I'm Smithers (stub upstream).";

/** AppState.ts:96 — the scan is only valid under the default palette. */
const DEFAULT_PALETTE = "night-owl";

/** uiCss.ts:50 — the one house interaction speed, and the reduced-motion baseline. */
const INTERACTION_SECONDS = 0.12;
/** tokens.css:739-747 collapses to 0.01ms, uiCss to 0.001ms; both land far under this. */
const COLLAPSED_SECONDS = 0.001;

interface A11yProbe {
	readonly transcriptRole: string | null;
	readonly transcriptLabel: string | null;
	readonly transcriptBusy: string | null;
	readonly composerStatus: string | null;
	readonly textareaLabel: string | null;
	readonly statusLive: string | null;
	readonly sendLabel: string | null;
	readonly stopLabel: string | null;
	readonly pendingRole: string | null;
	readonly pendingLive: string | null;
	readonly pendingLabel: string | null;
	readonly unlabelled: ReadonlyArray<string>;
	readonly markers: ReadonlyArray<{ readonly live: string | null; readonly text: string }>;
	readonly retry: boolean;
	readonly transcript: string;
}

/*
 * One read per phase. `.sui-sr-only` is clipped to a 1px box, so the pending
 * label is invisible to document.body.innerText and has to be read through
 * querySelector — a page.text() assertion would silently never see it.
 *
 * "Unlabelled" means a rendered button with neither visible text nor an
 * aria-label: the shape a screen reader announces as just "button".
 */
const A11Y_PROBE = `
(() => {
	const q = (selector) => document.querySelector(selector);
	const transcript = q('[data-slot="chat-transcript"]');
	const composer = q('[data-slot="chat-composer"]');
	const textarea = composer === null ? null : composer.querySelector("textarea");
	const unlabelled = Array.from(document.querySelectorAll("button"))
		.filter((button) => {
			const rect = button.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) return false;
			const visible = (button.textContent || "").trim();
			const label = (button.getAttribute("aria-label") || "").trim();
			const labelledBy = (button.getAttribute("aria-labelledby") || "").trim();
			const title = (button.getAttribute("title") || "").trim();
			return visible === "" && label === "" && labelledBy === "" && title === "";
		})
		.map((button) => String(button.className || button.outerHTML).slice(0, 60));
	const attribute = (node, name) => (node === null ? null : node.getAttribute(name));
	return {
		transcriptRole: attribute(transcript, "role"),
		transcriptLabel: attribute(transcript, "aria-label"),
		transcriptBusy: attribute(transcript, "aria-busy"),
		composerStatus: attribute(composer, "data-status"),
		textareaLabel: attribute(textarea, "aria-label"),
		statusLive: attribute(q(".sui-chat-composer-status"), "aria-live"),
		sendLabel: attribute(q(".sui-chat-composer-send"), "aria-label"),
		stopLabel: attribute(q(".sui-chat-composer-stop"), "aria-label"),
		pendingRole: attribute(q(".sui-chat-bubble-pending"), "role"),
		pendingLive: attribute(q(".sui-chat-bubble-pending"), "aria-live"),
		pendingLabel: q(".sui-chat-bubble-pending .sui-sr-only") === null
			? null
			: (q(".sui-chat-bubble-pending .sui-sr-only").textContent || "").trim(),
		unlabelled,
		markers: Array.from(document.querySelectorAll('[data-slot="marker"]')).map((marker) => ({
			live: marker.getAttribute("aria-live"),
			text: (marker.innerText || "").trim().slice(0, 140),
		})),
		retry: q('[aria-label=${JSON.stringify(RETRY_LABEL)}]') !== null,
		transcript: transcript === null ? "" : transcript.innerText,
	};
})()`;

/* -------------------------------------------------------------------------- */
/* The focus ring (E13.3)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How far apart two sRGB channels may sit and still be the same paint, on the
 * 0..1 scale: ~5/255. Wide enough to absorb an oklab round trip and Chrome's
 * float serialization, far narrower than the distance between `--brand` and
 * any other colour night-owl ships.
 */
const RING_TOLERANCE = 0.02;

/**
 * Chrome does not serialize one colour one way. `--brand` computes to `rgb()`,
 * `--ring` (a `color-mix`) computes to `color(srgb …)`, and a `box-shadow`
 * caught inside its .15s transition computes to `oklab(…)`. All three are the
 * same paint, so the comparison has to be numeric.
 *
 * `color-mix(in srgb, X 100%, transparent)` is the converter: Chrome resolves
 * it at computed-value time and always serializes the result as
 * `color(srgb r g b / a)`, whatever colour space X was written in. A token
 * Chrome cannot read as a colour — a length, `inset`, `none` — leaves the
 * sentinel in place and reads back as null, which is how a shadow's colour is
 * told apart from its offsets without depending on serialization order.
 */
const COLOR_HELPERS = `
	// A probe left behind by an evaluation that threw would be scanned as a real
	// element by E13.4, so every entry point sweeps the last one away first.
	for (const stale of Array.from(document.querySelectorAll("[data-e2e-color-probe]"))) stale.remove();
	const probe = document.createElement("div");
	probe.setAttribute("data-e2e-color-probe", "");
	probe.style.position = "fixed";
	probe.style.left = "-9999px";
	probe.style.top = "-9999px";
	document.body.append(probe);
	const SRGB = /^color\\(srgb ([-0-9.e]+) ([-0-9.e]+) ([-0-9.e]+)(?: \\/ ([-0-9.e]+))?\\)$/;
	const srgb = (value) => {
		probe.style.color = "rgb(1, 2, 3)";
		probe.style.color = "color-mix(in srgb, " + value + " 100%, transparent)";
		const match = SRGB.exec(getComputedStyle(probe).color);
		if (match === null) return null;
		return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
	};
	// Split a computed value on its top-level separator: the commas and spaces
	// inside colour functions belong to the colour, not to the list.
	const topLevel = (value, separator) => {
		const parts = [];
		let depth = 0;
		let start = 0;
		for (let index = 0; index < value.length; index += 1) {
			const character = value[index];
			if (character === "(") depth += 1;
			else if (character === ")") depth -= 1;
			else if (character === separator && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
		}
		parts.push(value.slice(start));
		return parts.map((part) => part.trim()).filter((part) => part !== "");
	};
	const shadowColor = (shadow) => {
		for (const token of topLevel(shadow, " ")) {
			const parsed = srgb(token);
			if (parsed !== null) return parsed;
		}
		return null;
	};
	// The ring is the brand hue at some alpha: --ring is 45%, the composer's
	// focus fill is 12%. Alpha is therefore not compared, only required to be
	// visible. ${RING_TOLERANCE} is ~${Math.round(RING_TOLERANCE * 255)}/255 per channel — far tighter than the
	// distance between --brand and any other colour in the palette, and far
	// looser than the rounding between one colour space and another.
	const sameHue = (colour, reference) =>
		colour !== null && reference !== null && colour[3] > 0.02 &&
		Math.abs(colour[0] - reference[0]) <= ${RING_TOLERANCE} &&
		Math.abs(colour[1] - reference[1]) <= ${RING_TOLERANCE} &&
		Math.abs(colour[2] - reference[2]) <= ${RING_TOLERANCE};
`;

/**
 * Wait out whatever is moving on an element instead of sleeping a number.
 * `.sui-chat-composer` transitions `box-shadow` over .15s (uiCss.ts:181), so a
 * fixed settle either reads the tween — Chrome serializes an in-flight
 * box-shadow colour as `oklab(…)` at 99.9999999% of the way there — or wastes
 * the difference on every one of sixty tab stops. The double rAF first lets the
 * style recalc that starts the transition run, or `getAnimations()` would
 * report an empty list on a transition that has not been created yet.
 */
const SETTLE_HELPER = `
	const settle = async (element) => {
		// A frame normally lands in ~32ms. The race is there because a frame that
		// never comes — the document navigated out from under the evaluation —
		// would otherwise hang the CDP call until the harness times it out.
		await new Promise((resolve) => {
			const go = () => { resolve(undefined); };
			setTimeout(go, 250);
			requestAnimationFrame(() => { requestAnimationFrame(go); });
		});
		const scope = [];
		let node = element;
		for (let depth = 0; node !== null && depth < 6; depth += 1) { scope.push(node); node = node.parentElement; }
		const deadline = performance.now() + 2000;
		for (;;) {
			const running = scope
				.flatMap((target) => target.getAnimations({ subtree: false }))
				.filter((animation) => animation.playState === "running");
			if (running.length === 0 || performance.now() >= deadline) return;
			// An infinite animation never finishes; the poll is what bounds it.
			await Promise.race([
				Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
				new Promise((resolve) => { setTimeout(resolve, 120); }),
			]);
		}
	};
`;

const RING_COLORS = `
(() => {
	${COLOR_HELPERS}
	try {
		const raw = (value) => { probe.style.color = ""; probe.style.color = value; return getComputedStyle(probe).color; };
		const brandRaw = raw("var(--brand)");
		const ringRaw = raw("var(--ring)");
		return { brandRaw, ringRaw, brand: srgb("var(--brand)"), ring: srgb("var(--ring)") };
	} finally {
		probe.remove();
	}
})()`;

/** A colour resolved to sRGB: r, g, b in 0..1 and alpha in 0..1. */
type Srgb = readonly [number, number, number, number];

interface RingColors {
	/** `--brand` and `--ring` exactly as Chrome serialized them, for the failure line. */
	readonly brandRaw: string;
	readonly ringRaw: string;
	readonly brand: Srgb | null;
	readonly ring: Srgb | null;
}

/** The same comparison `sameHue` makes in the page, for assertions made out here. */
const sameHue = (colour: Srgb | null, reference: Srgb | null): boolean =>
	colour !== null &&
	reference !== null &&
	Math.abs(colour[0] - reference[0]) <= RING_TOLERANCE &&
	Math.abs(colour[1] - reference[1]) <= RING_TOLERANCE &&
	Math.abs(colour[2] - reference[2]) <= RING_TOLERANCE;

interface RingStop {
	readonly tag: string;
	readonly className: string;
	readonly label: string;
	readonly focusVisible: boolean;
	readonly how: string;
	readonly focused: string;
	/** Populated only for a stop that paints no ring: why, in the cascade's own words. */
	readonly ancestry: ReadonlyArray<string>;
}

/**
 * Reads the ring off whatever element actually paints it. The composer's
 * textarea deliberately carries `outline:0` and lets `.sui-chat-composer:focus-within`
 * paint the ring for it (uiCss.ts:182,184), so an element-only rule would
 * report a false gap on the single most important affordance in the product.
 */
const ringStop = (colors: RingColors, index: number): string => `
(async () => {
	${COLOR_HELPERS}
	${SETTLE_HELPER}
	try {
		const element = document.activeElement;
		if (element === null || element === document.body || element === document.documentElement) return null;
		await settle(element);
		const brand = ${JSON.stringify(colors.brand)};
		const describe = (node) => {
			const style = getComputedStyle(node);
			const outlineColour = style.outlineStyle === "none" ? null : srgb(style.outlineColor);
			const shadows = style.boxShadow === "none" ? [] : topLevel(style.boxShadow, ",");
			return {
				outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 && sameHue(outlineColour, brand),
				shadow: shadows.some((shadow) => sameHue(shadowColor(shadow), brand)),
				value: style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor + " | " + style.boxShadow,
			};
		};
		const own = describe(element);
		let owner = null;
		let how = "";
		if (own.outline) { owner = element; how = "outline"; }
		else if (own.shadow) { owner = element; how = "shadow"; }
		else {
			let parent = element.parentElement;
			let depth = 0;
			while (parent !== null && depth < 4) {
				if (parent.matches(":focus-within")) {
					const up = describe(parent);
					if (up.outline || up.shadow) { owner = parent; how = up.outline ? "ancestor-outline" : "ancestor-shadow"; break; }
				}
				parent = parent.parentElement;
				depth += 1;
			}
		}
		if (owner !== null) owner.setAttribute("data-e2e-ring", String(${index}));
		// Only collected when nothing painted a ring: the two nearest ancestors and
		// what they resolve to is the evidence that names the offending cascade.
		const ancestry = [];
		if (owner === null) {
			let parent = element.parentElement;
			let depth = 0;
			while (parent !== null && depth < 2) {
				const style = getComputedStyle(parent);
				ancestry.push(String(parent.className || parent.tagName).slice(0, 40)
					+ " focus-within=" + parent.matches(":focus-within")
					+ " box-shadow=" + style.boxShadow.slice(0, 90)
					+ " parsed=" + JSON.stringify(topLevel(style.boxShadow, ",").map(shadowColor)));
				parent = parent.parentElement;
				depth += 1;
			}
		}
		const answer = {
			tag: element.tagName.toLowerCase(),
			className: String(element.className || "").slice(0, 60),
			label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 48),
			focusVisible: element.matches(":focus-visible"),
			how,
			focused: owner === null ? own.value : describe(owner).value,
			ancestry,
		};
		return answer;
	} finally {
		probe.remove();
	}
})()`;

/**
 * Blur, let the ring fade out, then read every stamped owner back. A ring that
 * survives a blur is not a focus ring. The read waits out the same transition
 * the walk waited out, so "identical with focus and without it" compares two
 * settled values rather than one settled value and one tween.
 */
const RELEASE_RINGS = `
(async () => {
	${SETTLE_HELPER}
	if (document.activeElement !== null && document.activeElement.blur) document.activeElement.blur();
	const stamped = Array.from(document.querySelectorAll("[data-e2e-ring]"));
	// Concurrently: sixteen owners fade out together, and settling them one after
	// another would bound this read at sixteen deadlines instead of one.
	await Promise.all(stamped.map((node) => settle(node)));
	const released = {};
	for (const node of stamped) {
		const style = getComputedStyle(node);
		released[node.getAttribute("data-e2e-ring")] =
			style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor + " | " + style.boxShadow;
		node.removeAttribute("data-e2e-ring");
	}
	return released;
})()`;

/* -------------------------------------------------------------------------- */
/* Token completeness (E13.4)                                                 */
/* -------------------------------------------------------------------------- */

/** `var(--house-token, #fallback)` — the only shape either source uses to declare a fallback. */
const FALLBACK_PATTERN = /var\((--[a-z0-9-]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))\)/g;

interface Consumed {
	readonly tokens: ReadonlyArray<string>;
	readonly fallbacks: ReadonlyArray<string>;
	/** Every `[token, fallback]` pair as written, so a waiver can drop one token's fallback. */
	readonly pairs: ReadonlyArray<readonly [string, string]>;
}

/**
 * Every house token consumed with a colour fallback, read from the library's
 * bridge and from the app's own stylesheets. Comment lines are skipped: the
 * bridge documents its own shape with a literal `var(--house-token, #lightFallback)`
 * that names no real token.
 */
const readConsumed = async (): Promise<Consumed> => {
	const sources: Array<string> = [];
	const bridge = fileURLToPath(new URL("../../node_modules/@smthrs/ui/src/tokens.ts", import.meta.url));
	sources.push(
		readFileSync(bridge, "utf8")
			.split("\n")
			.filter((line) => {
				const trimmed = line.trim();
				return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
			})
			.join("\n"),
	);
	const styles = fileURLToPath(new URL("../../src/mainview/styles/", import.meta.url));
	for await (const file of new Bun.Glob("*.css").scan({ cwd: styles, absolute: true })) {
		sources.push(readFileSync(file, "utf8"));
	}
	const tokens = new Set<string>();
	const fallbacks = new Set<string>();
	const pairs: Array<readonly [string, string]> = [];
	for (const source of sources) {
		FALLBACK_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null = FALLBACK_PATTERN.exec(source);
		while (match !== null) {
			const token = match[1] ?? "";
			const fallback = match[2] ?? "";
			tokens.add(token);
			fallbacks.add(fallback);
			pairs.push([token, fallback]);
			match = FALLBACK_PATTERN.exec(source);
		}
	}
	return { tokens: [...tokens], fallbacks: [...fallbacks], pairs };
};

interface TokenScan {
	readonly palette: string | null;
	readonly theme: string | null;
	readonly undefinedTokens: ReadonlyArray<string>;
	/** Every consumed token's resolved colour under this theme. */
	readonly real: ReadonlyArray<string>;
	/** fallback source text → the colour Chrome computes it to. */
	readonly painted: Readonly<Record<string, string>>;
	/** painted colour → where in the rendered tree it is being used. */
	readonly hits: Readonly<Record<string, ReadonlyArray<string>>>;
	readonly scanned: number;
}

/**
 * A token is undefined when `var(--token, A)` and `var(--token, B)` disagree:
 * the fallback is what is painting. That is the leak this row exists to catch,
 * and it is invisible to a test that reads tokens.css as text, because the
 * declaration may simply be missing for one theme.
 */
const tokenScan = (consumed: Consumed): string => `
((tokens, fallbacks) => {
	const probe = document.createElement("div");
	probe.style.position = "fixed";
	probe.style.left = "-9999px";
	document.body.append(probe);
	const paint = (value) => { probe.style.color = ""; probe.style.color = value; return getComputedStyle(probe).color; };
	const undefinedTokens = [];
	const real = [];
	for (const name of tokens) {
		const first = paint("var(" + name + ", rgb(1, 2, 3))");
		const second = paint("var(" + name + ", rgb(4, 5, 6))");
		if (first !== second) undefinedTokens.push(name);
		else real.push(first);
	}
	const painted = {};
	const watched = new Set();
	for (const fallback of fallbacks) {
		const value = paint(fallback);
		painted[fallback] = value;
		watched.add(value);
	}
	probe.remove();
	const PROPERTIES = ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor",
		"borderLeftColor", "outlineColor", "caretColor", "fill", "stroke", "textDecorationColor", "columnRuleColor"];
	const hits = {};
	const all = document.querySelectorAll("*");
	for (const element of all) {
		const style = getComputedStyle(element);
		for (const property of PROPERTIES) {
			const value = style[property];
			if (!watched.has(value)) continue;
			const bucket = hits[value] || (hits[value] = []);
			if (bucket.length < 6) {
				bucket.push(element.tagName.toLowerCase() + "." + String(element.className || "(no class)").slice(0, 40) + " " + property);
			}
		}
	}
	return {
		palette: document.documentElement.dataset.palette || null,
		theme: document.documentElement.dataset.theme || null,
		undefinedTokens,
		real,
		painted,
		hits,
		scanned: all.length,
	};
})(${JSON.stringify(consumed.tokens)}, ${JSON.stringify(consumed.fallbacks)})`;

/* -------------------------------------------------------------------------- */
/* Motion (E13.5)                                                             */
/* -------------------------------------------------------------------------- */

interface MotionProbe {
	readonly reduce: boolean;
	readonly buttonTransition: string | null;
	readonly moving: ReadonlyArray<string>;
	readonly movingCount: number;
	readonly stickyGap: number | null;
}

/**
 * `worst` takes the longest part of a comma-separated duration list: a
 * `.sui-button` reports "0.12s, 0.12s, 0.12s" for its three transitioned
 * properties, and one uncollapsed property in the list is still a defect.
 */
const MOTION_PROBE = `
(() => {
	const worst = (value) => {
		const parts = String(value).split(",").map((part) => parseFloat(part) || 0);
		return parts.length === 0 ? 0 : Math.max.apply(null, parts);
	};
	const moving = [];
	for (const element of document.querySelectorAll("*")) {
		const style = getComputedStyle(element);
		if (worst(style.transitionDuration) > ${COLLAPSED_SECONDS} || worst(style.animationDuration) > ${COLLAPSED_SECONDS}) {
			moving.push(element.tagName.toLowerCase() + "." + String(element.className || "(no class)").slice(0, 40)
				+ " transition=" + style.transitionDuration + " animation=" + style.animationDuration);
		}
	}
	const button = document.querySelector(".sui-button");
	const viewport = document.querySelector(".sui-msg-scroller-viewport");
	return {
		reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
		buttonTransition: button === null ? null : getComputedStyle(button).transitionDuration,
		moving: moving.slice(0, 8),
		movingCount: moving.length,
		stickyGap: viewport === null ? null : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
	};
})()`;

/* -------------------------------------------------------------------------- */
/* Keyboard helpers                                                            */
/* -------------------------------------------------------------------------- */

interface KeyDescriptor {
	readonly key: string;
	readonly code: string;
	readonly keyCode: number;
	/** Chrome only raises a keypress — and therefore a button's default activation — when a keyDown carries text. */
	readonly text?: string;
}

/** Browser.ts ships four descriptors and none of them activates a button. */
const BACKSPACE: KeyDescriptor = { key: "Backspace", code: "Backspace", keyCode: 8 };
const ACTIVATE: KeyDescriptor = { key: "Enter", code: "Enter", keyCode: 13, text: "\r" };

const pressKey = async (session: CdpSession, descriptor: KeyDescriptor): Promise<void> => {
	for (const type of ["keyDown", "keyUp"]) {
		await session.send("Input.dispatchKeyEvent", {
			type,
			key: descriptor.key,
			code: descriptor.code,
			windowsVirtualKeyCode: descriptor.keyCode,
			nativeVirtualKeyCode: descriptor.keyCode,
			...(type === "keyDown" && descriptor.text !== undefined ? { text: descriptor.text } : {}),
		});
	}
};

/** Move focus out of the document body so a walk always starts from the same place. */
const BLUR = `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`;

/** Who has focus right now, as an aria-label or tag name. */
const ACTIVE_LABEL = `(() => {
	const element = document.activeElement;
	if (element === null) return null;
	return (element.getAttribute("aria-label") || "") + "|" + element.tagName.toLowerCase() + "|" + String(element.className || "").slice(0, 40);
})()`;

/** Tab until `matches` accepts the focused element. Returns how many presses it took. */
const tabTo = async (
	session: CdpSession,
	report: Reporter,
	what: string,
	matches: (active: string) => boolean,
	limit = 45,
): Promise<number> => {
	for (let press = 1; press <= limit; press += 1) {
		await session.page.press("Tab");
		const active = await session.page.evaluate<string | null>(ACTIVE_LABEL);
		if (active !== null && matches(active)) return press;
	}
	return report.fail(`${what}: ${limit} Tab presses never reached it`);
};

/**
 * Walk the whole tab ring once and return every stop. Stops when the ring wraps
 * to its first stop, so a product that grows an affordance grows the walk.
 */
const walkRing = async (
	session: CdpSession,
	report: Reporter,
	colors: RingColors,
	where: string,
	/**
	 * `until` ends the walk early once the caller has what it came for. The open
	 * slash menu puts every registered command in the ring, and walking all of
	 * them re-proves one CSS rule sixty times.
	 */
	options: { readonly maxPresses?: number; readonly until?: (stops: ReadonlyArray<RingStop>) => boolean } = {},
): Promise<ReadonlyArray<RingStop>> => {
	await session.page.evaluate(BLUR);
	const stops: Array<RingStop> = [];
	const identity = (stop: RingStop): string => `${stop.tag}|${stop.className}|${stop.label}`;
	let empties = 0;
	for (let press = 0; press < (options.maxPresses ?? 60); press += 1) {
		await session.page.press("Tab");
		// ringStop settles the focused element's own transitions in the page, so
		// there is no fixed sleep here to race the .15s box-shadow tween.
		const stop = await session.page.evaluate<RingStop | null>(ringStop(colors, stops.length));
		if (stop === null) {
			empties += 1;
			// Focus left the document for the browser's own chrome; the next Tab
			// re-enters the page. Three in a row means it never came back.
			if (empties >= 3) break;
			continue;
		}
		empties = 0;
		if (stops.length > 2 && identity(stop) === identity(stops[0] as RingStop)) break;
		stops.push(stop);
		if (options.until?.(stops) === true) break;
	}
	// Always released, including on a short walk: a `data-e2e-ring` left stamped
	// on a node would be read back by the next walk as one of its own owners.
	// RELEASE_RINGS blurs and waits out the fade-out itself.
	const released = await session.page.evaluate<Record<string, string>>(RELEASE_RINGS);

	// The four things that can be wrong with a tab ring are independent, so all
	// four are measured before any of them fails: a walk that reports only its
	// first problem sends the next reader back for another five-minute run.
	const problems: Array<string> = [];
	const describe = (stop: RingStop): string =>
		`${stop.label || stop.tag}.${stop.className} → ${stop.focused} (ancestors: ${stop.ancestry.join(" | ")})`;
	if (stops.length < 5) {
		problems.push(`the ${where} tab ring held only ${stops.length} stop(s); the shell is not keyboard reachable`);
	}
	const unringed = stops.filter((stop) => stop.how === "");
	if (unringed.length > 0) {
		problems.push(`${where}: ${unringed.length} focus stop(s) paint no brand ring: ${unringed.map(describe).join(" ;; ")}`);
	}
	const blind = stops.filter((stop) => !stop.focusVisible).map((stop) => stop.label || stop.tag);
	if (blind.length > 0) {
		problems.push(`${where}: ${blind.length} focus stop(s) did not match :focus-visible after a real Tab: ${blind.join(", ")}`);
	}
	const permanent: Array<string> = [];
	for (const [index, after] of Object.entries(released)) {
		const stop = stops[Number(index)];
		if (stop === undefined) continue;
		if (stop.focused === after) permanent.push(`${stop.label || stop.tag}.${stop.className} → ${after}`);
	}
	if (Object.keys(released).length === 0) {
		problems.push(`${where}: no ring owner survived the walk, so the ring could not be proved focus-conditional`);
	}
	if (permanent.length > 0) {
		problems.push(
			`${where}: ${permanent.length} ring(s) look identical with focus and without it, so they are decoration, not a focus ring: ${permanent.join(" ;; ")}`,
		);
	}
	if (problems.length > 0) report.fail(problems.join(" ;; "));
	return stops;
};

const labelsOf = (stops: ReadonlyArray<RingStop>): ReadonlyArray<string> => stops.map((stop) => stop.label);

const requireLabels = (
	report: Reporter,
	stops: ReadonlyArray<RingStop>,
	required: ReadonlyArray<string>,
	where: string,
): void => {
	const seen = new Set(labelsOf(stops));
	const missing = required.filter((label) => !seen.has(label));
	if (missing.length > 0) {
		report.fail(`${where}: the tab ring never reached ${missing.join(", ")} (saw ${[...seen].join(" / ")})`);
	}
};

/* -------------------------------------------------------------------------- */
/* Independent sections                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One checklist row's worth of assertions, run to completion or recorded and
 * stepped over.
 *
 * Every assertion in the harness throws, which is right for a linear script and
 * wrong for a file that proves eight unrelated rows. A focus-ring regression
 * used to abort the run at check 5 of 16 and leave E13.1, E13.4, E13.5 and
 * E14.1 unrun, so one defect read as four unproven rows. A section catches its
 * own failure, records it, and lets the next row run; the suite fails at the
 * end with every failure in one message.
 *
 * A section is only ever skipped when the state it needs was never produced —
 * never to make a red run look shorter — and a skip is reported exactly like a
 * failure.
 */
interface SectionOutcome {
	readonly label: string;
	readonly state: "passed" | "failed" | "skipped";
	readonly reason: string;
}

/**
 * The failures that mean "the stack is restarting", not "the product is wrong".
 * Bun's fetch and the CDP client word a dead connection several ways, and all of
 * them arrive as a plain Error, so the message is the only thing to match on.
 */
const TRANSIENT_STACK =
	/socket connection was closed|Unable to connect|ConnectionRefused|ECONNREFUSED|ECONNRESET|EPIPE|connection closed|fetch failed|network error|The operation timed out|was aborted/i;

/** A response already read to completion, so a reload cannot cut its body short. */
interface Fetched {
	readonly status: number;
	readonly headers: Headers;
	readonly body: string;
}

/**
 * Every row that needs the signed-in page. Named once, so a session that never
 * opens reports fifteen skips with a reason instead of an empty run.
 */
const SIGNED_IN_SECTIONS = [
	"E14.5 (signed in)",
	"E13.2 (idle)",
	"E13.3 (brand colour)",
	"E13.3 (light ring)",
	"E13.1 (keyboard journey)",
	"E13.3 (dark ring)",
	"E13.4 (token scan)",
	"E13.4 (every consumed token is defined)",
	"E13.4 (no fallback paints)",
	"E13.5 (reduced motion)",
	"E14.3 (purged chunk in page)",
	"E14.1 (dropped stream)",
	"E14.1 (retry after a drop)",
	"E14.1 (offline send)",
	"E14.1 (retry after reconnect)",
] as const;
/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

export default defineSuite({
	id: "E13-E14",
	title: "the shell is announced, focusable, themed, motion-safe, and honest when the network or a cached bundle fails",
	browser: true,
	// The keyboard journey sends turns and flips the theme; a later suite gets a
	// clean origin from Browser.open()'s storage wipe, so this only needs to run late.
	order: 70,
	run: async ({ origin, stack, report, browser }) => {
		const outcomes: Array<SectionOutcome> = [];
		const section = async (label: string, body: () => Promise<void>): Promise<boolean> => {
			try {
				await body();
				outcomes.push({ label, state: "passed", reason: "" });
				return true;
			} catch (error) {
				// A harness error (a dead CDP round trip, a bug in this file) is as
				// much a failure of this row as a failed assertion, and it must not
				// take the other rows with it either.
				const reason =
					error instanceof SuiteFailure
						? error.message
						: `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
				outcomes.push({ label, state: "failed", reason });
				console.error(`fail: E13-E14 ${label} — ${reason}`);
				return false;
			}
		};
		const skipSection = (label: string, reason: string): void => {
			outcomes.push({ label, state: "skipped", reason });
			console.error(`skip: E13-E14 ${label} — ${reason}`);
		};

		/**
		 * `wrangler dev` reloads itself whenever a sibling touches apps/server or
		 * rebuilds the SPA (run.ts:205-208), and a reload refuses connections for a
		 * second or two. That is an event in the runner, not a fact about the
		 * product: the request is re-sent once the origin answers again. Only
		 * connection-level failures are retried. A SuiteFailure is an assertion and
		 * is rethrown untouched, so no retry can turn a red row green.
		 */
		const transient = async <A>(what: string, body: () => Promise<A>, attempts = 4): Promise<A> => {
			let last: unknown;
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				try {
					return await body();
				} catch (error) {
					if (error instanceof SuiteFailure) throw error;
					const message = error instanceof Error ? error.message : String(error);
					if (!TRANSIENT_STACK.test(message)) throw error;
					last = error;
					console.log(`retry: E13-E14 ${what} — the stack was not answering (${message}); attempt ${attempt} of ${attempts}.`);
					// Wait for the reload to land instead of sleeping a fixed number.
					for (let probe = 0; probe < 60; probe += 1) {
						try {
							const response = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
							if (response.ok) break;
						} catch {
							// Still reloading. The next probe tells a reload from a death.
						}
						await wait(500);
					}
				}
			}
			throw last instanceof Error ? last : new Error(String(last));
		};

		/** One request, read to completion, retried across a reload. */
		const get = (what: string, url: string): Promise<Fetched> =>
			transient(what, async () => {
				const response = await fetch(url);
				return { status: response.status, headers: response.headers, body: await response.text() };
			});

		// Parsing the token sources is E13.4's precondition and nothing else's, so
		// a bad parse fails that row instead of aborting the file.
		let parsedTokens: Consumed | null = null;
		await section("E13.4 (the consumed-token sources)", async () => {
			const parsed = await readConsumed();
			report.check(parsed.tokens.length > 10, `only ${parsed.tokens.length} house tokens were parsed out of the sources`);
			parsedTokens = parsed;
		});
		const consumed = parsedTokens as Consumed | null;

		// ------------------------------------------------------------------
		// E14.3 (server half) — the cache policy that keeps a deploy from
		// wedging a browser that still holds the previous bundle.
		// ------------------------------------------------------------------
		await section("E14.3 (cache policy)", async () => {
			const root = await get("the SPA entry point", origin);
			report.equals(root.status, 200, "the SPA entry point");
			const rootCache = root.headers.get("cache-control") ?? "";
			report.includes(rootCache, "max-age=0", "index.html cache-control");
			report.includes(rootCache, "must-revalidate", "index.html cache-control");
			report.check(root.headers.get("etag") !== null, "index.html carries no ETag, so revalidation has nothing to compare");
			const entry = /<script[^>]+src="([^"]+)"/.exec(root.body)?.[1] ?? "";
			report.check(
				/^\/assets\/index-[A-Za-z0-9_-]{8}\.js$/.test(entry),
				`the entry script ${JSON.stringify(entry)} is not content-hashed, so a deploy cannot invalidate it`,
			);
			const asset = await get("the hashed entry script", `${origin}${entry}`);
			report.equals(asset.status, 200, "the hashed entry script");
			report.includes(asset.headers.get("content-type") ?? "", "text/javascript", "the entry script content-type");
			report.check(asset.headers.get("etag") !== null, "the entry script carries no ETag");
			report.includes(asset.headers.get("cache-control") ?? "", "must-revalidate", "the entry script cache-control");
			/*
			 * The wedge this row is really about: a purged chunk answered with the SPA
			 * shell. The browser then parses HTML as a module, every import fails, and
			 * the app is a white screen until the user clears their cache by hand.
			 */
			const purged = await get("a purged content-hashed chunk", `${origin}/assets/index-STALEHASH.js`);
			report.equals(purged.status, 404, "a purged content-hashed chunk");
			report.check(
				!(purged.headers.get("content-type") ?? "").includes("text/html"),
				`a purged chunk was answered as ${purged.headers.get("content-type")}, so an SPA fallback is swallowing missing assets`,
			);
			report.ok("E14.3 — index.html revalidates, assets are content-hashed, and a purged chunk 404s instead of falling back to HTML.");
		});

		// ------------------------------------------------------------------
		// E14.5 (signed out) + E13.2 (signed out) — the pre-auth load.
		// ------------------------------------------------------------------
		await section("E14.5/E13.2 (signed out)", async () => {
			const anonymous = await browser.open();
			try {
				await waitUntil(
					report,
					"the signed-out shell never mounted a composer",
					async () => (await anonymous.page.evaluate<boolean>(`document.querySelector(".smithers-composer textarea") !== null`)) === true,
					30_000,
				);
				// Let the first-run seams settle: a console error raised by a late
				// /api/reco or /api/billing response would otherwise land after the read.
				await wait(2_500);
				const anonymousProbe = await anonymous.page.evaluate<A11yProbe>(A11Y_PROBE);
				report.equals(anonymousProbe.transcriptRole, "log", "the signed-out transcript role");
				report.equals(anonymousProbe.transcriptLabel, TRANSCRIPT_LABEL, "the signed-out transcript aria-label");
				report.equals(anonymousProbe.textareaLabel, TEXTAREA_LABEL, "the signed-out composer textarea aria-label");
				report.equals(anonymousProbe.unlabelled.length, 0, `unlabelled buttons on the signed-out load: ${anonymousProbe.unlabelled.join(", ")}`);
				const anonymousErrors = anonymous.consoleErrors();
				report.equals(anonymousErrors.length, 0, `console errors on the signed-out load: ${anonymousErrors.join(" ;; ")}`);
				report.ok("E14.5/E13.2 — the signed-out load raises no console error and announces the transcript and composer.");
			} finally {
				anonymous.close();
			}
		});

		// ------------------------------------------------------------------
		// The signed-in page every remaining row runs against.
		// ------------------------------------------------------------------
		/*
		 * Opening the signed-in page used to be a bare pair of awaits out here, so a
		 * wrangler reload landing on the sign-in round trip aborted the whole file
		 * and deleted fifteen rows that the reload had nothing to do with. It is a
		 * section like everything else now, and the round trip is retried.
		 *
		 * stack.signedInCookie() memoizes its promise, rejection included, so a
		 * retry through it would replay the same failure. signIn() + allowlist() is
		 * the same work without the memo.
		 */
		let openedSession: CdpSession | null = null;
		await section("the signed-in session", async () => {
			const cookie = await transient("the signed-in cookie", async () => {
				const value = await stack.signIn();
				await stack.allowlist();
				return value;
			});
			openedSession = await transient("the signed-in browser session", () => browser.open(cookie));
		});
		const session = openedSession as CdpSession | null;

		const signedIn = async (session: CdpSession): Promise<void> => {
			const page = session.page;
			const evaluate = page.evaluate;

			/**
			 * Cleanup, not a check: a section that failed halfway can leave a draft or
			 * an open slash menu behind, and Enter means something else entirely with
			 * the command menu open. Deliberately silent — a page too broken to tidy
			 * fails the next section on its own terms.
			 */
			const tidyComposer = async (): Promise<void> => {
				try {
					await evaluate(
						`(() => { const input = document.querySelector(".smithers-composer textarea"); if (input !== null) { input.focus(); input.select(); } return true; })()`,
					);
					for (let press = 0; press < 3; press += 1) {
						await pressKey(session, BACKSPACE);
						await wait(80);
					}
					await page.press("Escape");
					await wait(200);
					await evaluate(BLUR);
				} catch {
					/* fall through */
				}
			};

			const mounted = await section("the signed-in shell", async () => {
				await waitUntil(
					report,
					"the signed-in shell never mounted a composer",
					async () => (await evaluate<boolean>(`document.querySelector(".smithers-composer textarea") !== null`)) === true,
					30_000,
				);
				await waitUntil(
					report,
					"the balance chip never arrived, so the page is not the signed-in shell",
					async () => (await evaluate<boolean>(`document.querySelector('[aria-label=${JSON.stringify(BALANCE_LABEL)}]') !== null`)) === true,
					30_000,
				);
			});
			if (!mounted) {
				for (const label of SIGNED_IN_SECTIONS) {
					skipSection(label, "the signed-in shell never mounted");
				}
				return;
			}

			await section("E14.5 (signed in)", async () => {
				await wait(2_500);
				const signedInErrors = session.consoleErrors();
				report.equals(signedInErrors.length, 0, `console errors on the signed-in load: ${signedInErrors.join(" ;; ")}`);
				report.ok("E14.5 — the signed-in load raises no console error.");
			});

			// ------------------------------------------------------------------
			// E13.2 — the idle contract.
			// ------------------------------------------------------------------
			await section("E13.2 (idle)", async () => {
				const idle = await evaluate<A11yProbe>(A11Y_PROBE);
				report.equals(idle.transcriptRole, "log", "the transcript role");
				report.equals(idle.transcriptLabel, TRANSCRIPT_LABEL, "the transcript aria-label");
				report.equals(idle.transcriptBusy, "false", "the idle transcript aria-busy");
				report.equals(idle.composerStatus, "ready", "the idle composer data-status");
				report.equals(idle.textareaLabel, TEXTAREA_LABEL, "the composer textarea aria-label");
				report.equals(idle.statusLive, "polite", "the composer status region aria-live");
				report.equals(idle.sendLabel, SEND_LABEL, "the send button aria-label");
				report.equals(idle.stopLabel, null, "an idle composer must not render a stop button");
				report.equals(idle.pendingRole, null, "an idle transcript must not render a pending bubble");
				report.equals(idle.unlabelled.length, 0, `unlabelled buttons on the signed-in load: ${idle.unlabelled.join(", ")}`);
				report.ok("E13.2 — the idle transcript is a labelled log, the composer states ready, and every rendered button has a name.");
			});

			// ------------------------------------------------------------------
			// E13.3 — the tab ring in light mode.
			// ------------------------------------------------------------------
			let lightColors: RingColors | null = null;
			await section("E13.3 (brand colour)", async () => {
				const colors = await evaluate<RingColors>(RING_COLORS);
				report.check(
					colors.brand !== null,
					`--brand does not resolve to a colour in light mode (saw ${colors.brandRaw})`,
				);
				report.check(
					colors.ring !== null,
					`--ring does not resolve to a colour in light mode (saw ${colors.ringRaw})`,
				);
				// The ring is the brand at 45% alpha, so a --ring that is not the
				// brand hue means the whole walk below would be measuring nothing.
				report.check(
					sameHue(colors.ring, colors.brand),
					`--ring (${colors.ringRaw}) is not the --brand hue (${colors.brandRaw}), so a brand-ring assertion cannot mean anything`,
				);
				lightColors = colors;
			});
			const light = lightColors as RingColors | null;

			if (light === null) {
				skipSection("E13.3 (light ring)", "the brand colour never resolved");
			} else {
				await section("E13.3 (light ring)", async () => {
					const lightStops = await walkRing(session, report, light, "light");
					requireLabels(report, lightStops, [TEXTAREA_LABEL, THEME_LABEL, SURFACES_LABEL, COPY_LABEL, BALANCE_LABEL], "light");
					report.ok(`E13.3 — all ${lightStops.length} light-mode tab stops paint a focus-conditional brand ring.`);
				});
			}

			// ------------------------------------------------------------------
			// E13.1 — the keyboard-only journey. Nothing below dispatches a mouse
			// event until this section ends: focus arrives by Tab, the slash menu
			// opens by typing, the turn is sent by Enter, and the theme is flipped
			// by Enter on the button the ring reached.
			// ------------------------------------------------------------------
			// Read outside a section, so it cannot throw one away: a page too broken
			// to answer this leaves the dark walk to flip the theme on its own.
			const themeAtStart = await evaluate<string | null>(`document.documentElement.dataset.theme || null`).catch(
				() => null,
			);
			if (light === null) {
				skipSection("E13.1 (keyboard journey)", "the brand colour never resolved, so the slash-menu ring could not be walked");
			} else {
				await section("E13.1 (keyboard journey)", async () => {
					await evaluate(BLUR);
					const toComposer = await tabTo(session, report, "the composer is not reachable by Tab", (active) =>
						active.startsWith(`${TEXTAREA_LABEL}|textarea`),
					);
					report.check(toComposer <= 45, `the composer took ${toComposer} Tab presses to reach`);

					// A "/" in an empty composer is the keyboard route into the command
					// registry; if it stops opening, the keyboard journey loses every flow
					// that has no on-screen button.
					await page.press("/");
					await waitUntil(
						report,
						"typing / into the empty composer never opened the slash menu",
						async () => (await evaluate<boolean>(`document.querySelector(".slash-menu") !== null`)) === true,
						5_000,
					);
					const slashStops = await walkRing(session, report, light, "slash menu", {
						maxPresses: 90,
						until: (stops) => stops.filter((stop) => stop.className.includes("slash-menu-item")).length >= 3,
					});
					const slashItems = slashStops.filter((stop) => stop.className.includes("slash-menu-item"));
					report.check(slashItems.length >= 3, "the open slash menu contributed no focus stop, so its commands are mouse-only");
					// The send button is `disabled` on an empty draft (ChatComposer.tsx:65,157),
					// so it is legitimately absent from the ring until something is typed.
					report.equals(
						await evaluate<boolean | null>(`(document.querySelector(".sui-chat-composer-send") || {}).disabled ?? null`),
						false,
						"the send button is still disabled with a draft in the composer",
					);
					report.ok(`E13.3/E13.1 — the slash menu opens from the keyboard and its ${slashItems.length} items ring like every other affordance.`);

					/*
					 * Every registered command is a focus stop while the menu is open, so the
					 * composer now sits far down the ring. The limit is raised rather than the
					 * route changed: Escape only dismisses the menu from inside the textarea
					 * (App.tsx:622-625), and this leg must stay keyboard-only.
					 */
					await evaluate(BLUR);
					await tabTo(
						session,
						report,
						"the composer is not reachable by Tab after the slash menu",
						(active) => active.startsWith(`${TEXTAREA_LABEL}|textarea`),
						120,
					);
					await pressKey(session, BACKSPACE);
					await waitUntil(
						report,
						"Backspace never cleared the slash draft",
						async () => (await evaluate<boolean>(`document.querySelector(".slash-menu") === null`)) === true,
						5_000,
					);

					/*
					 * A paced script, so the streaming half of E13.2 is observable: the
					 * default script finishes in ~30ms and the pending bubble would be gone
					 * before the first read.
					 */
					stack.chat.script({
						gapMs: 220,
						frames: [
							...Array.from({ length: 8 }, (_unused, index) => ({
								type: "delta",
								kind: "text",
								text: `keyboard turn part ${index} `,
							})),
							{ type: "done", reason: "stop" },
						],
					});
					const beforeTurn = await evaluate<string>(`document.querySelector('[data-slot="chat-transcript"]').innerText`);
					await page.type("send this with the keyboard only");
					await page.press("Enter");

					// E13.2 — the streaming contract.
					let streaming: A11yProbe | undefined;
					await waitUntil(
						report,
						"the keyboard-sent turn never entered the streaming state",
						async () => {
							streaming = await evaluate<A11yProbe>(A11Y_PROBE);
							return streaming.transcriptBusy === "true" && streaming.pendingRole !== null;
						},
						30_000,
					);
					const live = streaming as A11yProbe;
					report.equals(live.transcriptBusy, "true", "the streaming transcript aria-busy");
					report.equals(live.composerStatus, "submitted", "the streaming composer data-status");
					report.equals(live.pendingRole, "status", "the pending bubble role");
					report.equals(live.pendingLive, "polite", "the pending bubble aria-live");
					report.equals(live.pendingLabel, PENDING_LABEL, "the pending bubble's screen-reader text");
					report.equals(live.stopLabel, STOP_LABEL, "the streaming composer's stop button aria-label");
					report.ok("E13.2 — a streaming turn marks the log busy and announces itself through a polite status region.");

					await waitUntil(
						report,
						"the keyboard-sent turn never completed",
						async () => {
							const probe = await evaluate<A11yProbe>(A11Y_PROBE);
							return probe.transcriptBusy === "false" && probe.pendingRole === null && probe.transcript.includes("keyboard turn part 7");
						},
						60_000,
					);
					const afterTurn = await evaluate<string>(`document.querySelector('[data-slot="chat-transcript"]').innerText`);
					const reply = afterTurn.startsWith(beforeTurn) ? afterTurn.slice(beforeTurn.length) : afterTurn;
					report.check(
						hasSmithersMessage(reply),
						`the keyboard-only turn produced no useful reply (${JSON.stringify(reply.slice(0, 160))})`,
					);

					// The journey's last leg: reach a command button by Tab and run it by
					// Enter. A theme flip is the cheapest command with a DOM-visible result.
					await evaluate(BLUR);
					await tabTo(session, report, "the theme toggle is not reachable by Tab", (active) =>
						active.startsWith(`${THEME_LABEL}|`),
					);
					const themeBefore = await evaluate<string | null>(`document.documentElement.dataset.theme || null`);
					await pressKey(session, ACTIVATE);
					await waitUntil(
						report,
						`Enter on the focused theme toggle never changed data-theme (still ${themeBefore})`,
						async () => (await evaluate<string | null>(`document.documentElement.dataset.theme || null`)) !== themeBefore,
						10_000,
					);
					const themeAfter = await evaluate<string | null>(`document.documentElement.dataset.theme || null`);
					report.equals(themeAfter, themeBefore === "dark" ? "light" : "dark", "the theme after Enter on the toggle");
					report.ok(
						`E13.1 — Tab reached the composer in ${toComposer} presses, "/" opened the registry, Enter sent the turn and got a reply, and Enter on the toggle ran a command. No pointer event was dispatched.`,
					);
				});
			}
			await tidyComposer();

			// ------------------------------------------------------------------
			// E13.3 — the same walk in the other theme. --brand and --ring both
			// change with the theme, so a ring hardcoded to one palette passes here
			// and fails for half the users. The flip is re-done with a click when
			// the keyboard journey did not get that far, so this row survives that
			// row's failure.
			// ------------------------------------------------------------------
			if (light === null) {
				skipSection("E13.3 (dark ring)", "the brand colour never resolved");
			} else {
				await section("E13.3 (dark ring)", async () => {
					if ((await evaluate<string | null>(`document.documentElement.dataset.theme || null`)) === themeAtStart) {
						await evaluate(`document.querySelector('[aria-label=${JSON.stringify(THEME_LABEL)}]').click(); true`);
						await waitUntil(
							report,
							`the theme toggle never moved the page off ${themeAtStart}`,
							async () => (await evaluate<string | null>(`document.documentElement.dataset.theme || null`)) !== themeAtStart,
							10_000,
						);
					}
					const theme = await evaluate<string | null>(`document.documentElement.dataset.theme || null`);
					const darkColors = await evaluate<RingColors>(RING_COLORS);
					report.check(
						darkColors.brand !== null && !sameHue(darkColors.brand, light.brand),
						`--brand did not change with the theme (still ${darkColors.brandRaw}), so the two walks prove one palette twice`,
					);
					const darkStops = await walkRing(session, report, darkColors, String(theme));
					requireLabels(report, darkStops, [TEXTAREA_LABEL, THEME_LABEL, SURFACES_LABEL, COPY_LABEL, BALANCE_LABEL], String(theme));
					report.ok(`E13.3 — all ${darkStops.length} ${theme}-mode tab stops paint a focus-conditional brand ring against the ${theme} brand.`);
				});
			}

			// ------------------------------------------------------------------
			// E13.4 — no library fallback paints anywhere, in either theme, and
			// every consumed token is actually defined.
			// ------------------------------------------------------------------
			if (consumed === null) {
				for (const label of ["E13.4 (token scan)", "E13.4 (every consumed token is defined)", "E13.4 (no fallback paints)"]) {
					skipSection(label, "the consumed-token sources never parsed");
				}
			} else {
				// Annotated, not inferred: TypeScript does not carry a narrowing into
				// the section callbacks, and every one of them reads this.
				const sources: Consumed = consumed;
				const scans: Array<TokenScan> = [];
				const scanned = await section("E13.4 (token scan)", async () => {
					scans.push(await evaluate<TokenScan>(tokenScan(sources)));
					// Back to the other theme, and with a second surface on screen so the
					// scan covers a pane the chat column never renders.
					await evaluate(`document.querySelector('[aria-label=${JSON.stringify(THEME_LABEL)}]').click(); true`);
					await wait(600);
					await evaluate(`document.querySelector(".composer-menu-trigger").click(); true`);
					await waitUntil(
						report,
						"the Surfaces menu never opened, so the token scan would only cover the chat column",
						async () => (await evaluate<number>(`document.querySelectorAll(".composer-menu-item").length`)) > 0,
						10_000,
					);
					scans.push(await evaluate<TokenScan>(tokenScan(sources)));
					await page.press("Escape");
					await wait(300);

					const themesScanned = scans.map((scan) => scan.theme);
					report.check(
						new Set(themesScanned).size === 2,
						`the token scan ran twice in the same theme (${themesScanned.join(", ")}), so one theme is unproven`,
					);
					for (const scan of scans) {
						report.equals(scan.palette, DEFAULT_PALETTE, "the live palette during the token scan");
						report.check(
							scan.scanned > 50,
							`the ${scan.theme} token scan saw only ${scan.scanned} elements; the tree was not rendered`,
						);
					}
				});

				if (!scanned) {
					skipSection("E13.4 (every consumed token is defined)", "the two-theme token scan never completed");
					skipSection("E13.4 (no fallback paints)", "the two-theme token scan never completed");
				} else {
					await section("E13.4 (every consumed token is defined)", async () => {
						for (const scan of scans) {
							for (const name of scan.undefinedTokens) {
								const fallback = sources.pairs.find(([token]) => token === name)?.[1] ?? "?";
								const painted = scan.painted[fallback] ?? "?";
								const where = scan.hits[painted] ?? [];
								console.log(
									`gap: E13.4 ${scan.theme} — ${name} is never defined, so its ${fallback} fallback paints (${where.length === 0 ? "not on screen right now" : where.join(" / ")})`,
								);
							}
						}
						for (const scan of scans) {
							report.equals(
								scan.undefinedTokens.length,
								0,
								`house tokens consumed but never defined in ${scan.theme}: ${scan.undefinedTokens.join(", ")} — the consumer's own fallback is painting`,
							);
						}
						report.ok(`E13.4 — all ${sources.tokens.length} consumed house tokens resolve in both themes.`);
					});

					await section("E13.4 (no fallback paints)", async () => {
						/*
						 * A fallback colour that is ALSO a real palette value in either theme
						 * cannot discriminate a leak: white is night-owl's real `--surface` in
						 * light and Chrome's field text under a dark colour-scheme. Dropping it
						 * is what keeps this scan from crying wolf, and the undefined-token
						 * check above still catches a token whose fallback happens to be white.
						 */
						const realUnion = new Set(scans.flatMap((scan) => scan.real));
						const sentinels = new Set(Object.values(scans[0]?.painted ?? {}).filter((value) => !realUnion.has(value)));
						report.check(
							sentinels.size >= 8,
							`only ${sentinels.size} fallback colours are distinguishable from the live palette; the scan has no teeth`,
						);
						for (const scan of scans) {
							const leaks = Object.entries(scan.hits)
								.filter(([value]) => sentinels.has(value))
								.map(([value, where]) => `${value} at ${where.join(" / ")}`);
							report.equals(
								leaks.length,
								0,
								`library/app token fallbacks painted in the rendered ${scan.theme} tree: ${leaks.join(" ;; ")}`,
							);
						}
						report.ok(
							`E13.4 — none of the ${sentinels.size} discriminating library/app fallbacks paints anywhere in the rendered tree, in either theme.`,
						);
					});
				}
			}

			// ------------------------------------------------------------------
			// E13.5 — prefers-reduced-motion.
			// ------------------------------------------------------------------
			await section("E13.5 (reduced motion)", async () => {
				try {
					const baseline = await evaluate<MotionProbe>(MOTION_PROBE);
					report.equals(baseline.reduce, false, "the un-emulated page must not already report reduced motion");
					report.check(
						baseline.buttonTransition !== null && parseFloat(baseline.buttonTransition) >= INTERACTION_SECONDS - 0.001,
						`the house button transition is ${baseline.buttonTransition}, not the ${INTERACTION_SECONDS}s interaction speed, so the reduced-motion assertion proves nothing`,
					);
					report.check(
						baseline.movingCount > 0,
						"nothing on the page animates or transitions at all, so a collapsed-motion assertion would pass vacuously",
					);
					await session.media("prefers-reduced-motion", "reduce");
					// The media query is live, but a reload removes any doubt about styles
					// computed before the emulation landed.
					await page.reload();
					await waitUntil(
						report,
						"the shell never came back after the reduced-motion reload",
						async () => (await evaluate<boolean>(`document.querySelector(".smithers-composer textarea") !== null`)) === true,
						30_000,
					);
					const reduced = await evaluate<MotionProbe>(MOTION_PROBE);
					report.equals(reduced.reduce, true, "the emulated prefers-reduced-motion media query");
					report.equals(
						reduced.movingCount,
						0,
						`${reduced.movingCount} element(s) still animate or transition under prefers-reduced-motion: ${reduced.moving.join(" ;; ")}`,
					);
					report.check(
						reduced.stickyGap !== null && reduced.stickyGap <= 4,
						`the transcript is ${reduced.stickyGap}px from the bottom under reduced motion, so the smooth→auto scroll downgrade broke stickiness`,
					);
					report.ok(
						`E13.5 — ${baseline.movingCount} moving element(s) collapse to zero under prefers-reduced-motion, and the transcript still scrolls to the newest message.`,
					);
				} finally {
					// The emulation is process-wide for this page; every row after this
					// one reads real styles, so it comes off even when the row failed.
					await session.send("Emulation.setEmulatedMedia", { features: [] });
					await page.reload();
					await waitUntil(
						report,
						"the shell never came back after clearing the media emulation",
						async () => (await evaluate<boolean>(`document.querySelector(".smithers-composer textarea") !== null`)) === true,
						30_000,
					);
				}
			});

			// ------------------------------------------------------------------
			// E14.3 (browser half) — a purged chunk does not wedge the running app,
			// and nothing has introduced a service worker that could cache one.
			// ------------------------------------------------------------------
			await section("E14.3 (purged chunk in page)", async () => {
				const purgedInPage = await evaluate<{ status: number; contentType: string | null }>(
					`fetch("/assets/index-STALEHASH.js").then((response) => ({ status: response.status, contentType: response.headers.get("content-type") }))`,
				);
				report.equals(purgedInPage.status, 404, "a purged chunk requested from the running page");
				report.check(
					purgedInPage.contentType === null || !purgedInPage.contentType.includes("text/html"),
					`the page was handed ${purgedInPage.contentType} for a purged chunk`,
				);
				report.equals(
					await evaluate<string>(
						`navigator.serviceWorker === undefined ? "no-api" : (navigator.serviceWorker.controller === null ? "none" : "controlled")`,
					),
					"none",
					"a service worker is controlling the page, which re-opens the stale-bundle hole the cache policy closes",
				);
				report.check(
					(await evaluate<boolean>(`document.querySelector('[data-slot="chat-composer"]') !== null`)) === true,
					"the app did not survive a 404 on a purged chunk",
				);
				report.ok("E14.3 — a purged chunk 404s inside the running page, no service worker is registered, and the shell stays alive.");
			});

			// ------------------------------------------------------------------
			// E14.1 — a turn whose stream dies mid-flight.
			//
			// The script ends without a terminal frame, which is exactly what the
			// client sees when the connection drops: EOF with the turn unfinished.
			// ------------------------------------------------------------------
			let beforeDrop = "";
			const dropShown = await section("E14.1 (dropped stream)", async () => {
				stack.chat.script({
					gapMs: 150,
					frames: [
						{ type: "delta", kind: "text", text: "partial answer before the drop" },
						{ type: "delta", kind: "text", text: " and a little more" },
					],
				});
				beforeDrop = await evaluate<string>(`document.querySelector('[data-slot="chat-transcript"]').innerText`);
				await evaluate(`(() => { const input = document.querySelector(".smithers-composer textarea"); input.focus(); input.select(); return true; })()`);
				await page.type("answer this before the wire dies");
				await page.press("Enter");

				let dropped: A11yProbe | undefined;
				await waitUntil(
					report,
					"the dropped turn never resolved; the transcript is still waiting",
					async () => {
						dropped = await evaluate<A11yProbe>(A11Y_PROBE);
						return dropped.retry === true;
					},
					45_000,
				);
				const interrupted = dropped as A11yProbe;
				report.equals(interrupted.transcriptBusy, "false", "the transcript aria-busy after the drop");
				report.equals(interrupted.composerStatus, "ready", "the composer data-status after the drop");
				report.equals(interrupted.pendingRole, null, "a pending bubble survived the drop, so the turn still looks alive");
				report.check(
					interrupted.markers.some((marker) => marker.text.includes(INTERRUPTED_NOTE) && marker.live === "polite"),
					`the drop produced no polite "${INTERRUPTED_NOTE}" note (saw ${JSON.stringify(interrupted.markers)})`,
				);
				report.includes(interrupted.transcript, "partial answer before the drop", "the partial answer the drop interrupted");
				report.ok("E14.1 — a turn whose stream dies mid-flight settles to idle with a live interrupted note, the partial text kept, and a retry affordance.");
			});

			// The same turn, retried, must actually complete.
			if (!dropShown) {
				skipSection("E14.1 (retry after a drop)", "no dropped turn was left on screen to retry");
			} else {
				await section("E14.1 (retry after a drop)", async () => {
					stack.chat.reset();
					await evaluate(`(() => { const buttons = Array.from(document.querySelectorAll('[aria-label=${JSON.stringify(RETRY_LABEL)}]')); buttons[buttons.length - 1].click(); return true; })()`);
					await waitUntil(
						report,
						"the retried turn never produced a completed reply",
						async () => {
							const probe = await evaluate<A11yProbe>(A11Y_PROBE);
							return probe.transcriptBusy === "false" && probe.pendingRole === null && probe.transcript.includes(STUB_REPLY);
						},
						45_000,
					);
					const recovered = await evaluate<string>(`document.querySelector('[data-slot="chat-transcript"]').innerText`);
					report.check(
						recovered.length > beforeDrop.length,
						"the retried turn did not grow the transcript, so recovery replaced history instead of adding to it",
					);
					report.includes(recovered, INTERRUPTED_NOTE, "the interrupted note after a successful retry");
					report.ok("E14.1 — retrying the dropped turn completes it, and the honest record of the interruption stays on screen.");
				});
			}

			// ------------------------------------------------------------------
			// E14.1 — the network is already down when the user presses Enter.
			// CDP's offline emulation blocks new connections, which is the case
			// the truncated stream above cannot reach.
			// ------------------------------------------------------------------
			const wentOffline = await section("E14.1 (offline send)", async () => {
				try {
					await session.send("Network.emulateNetworkConditions", {
						offline: true,
						latency: 0,
						downloadThroughput: -1,
						uploadThroughput: -1,
					});
					await evaluate(`(() => { const input = document.querySelector(".smithers-composer textarea"); input.focus(); input.select(); return true; })()`);
					await page.type("this one is sent with the wire pulled");
					await page.press("Enter");
					let offline: A11yProbe | undefined;
					await waitUntil(
						report,
						"a send with the network down never resolved; the composer is stuck",
						async () => {
							offline = await evaluate<A11yProbe>(A11Y_PROBE);
							return offline.composerStatus === "ready" && offline.transcript.includes(FAILED_MESSAGE_LEAD);
						},
						45_000,
					);
					const down = offline as A11yProbe;
					report.equals(down.transcriptBusy, "false", "the transcript aria-busy after an offline send");
					report.equals(down.pendingRole, null, "a pending bubble survived an offline send");
					report.check(
						down.markers.some((marker) => marker.text.includes(FAILED_NOTE)),
						`an offline send left no "${FAILED_NOTE}" note (saw ${JSON.stringify(down.markers)})`,
					);
					report.equals(down.retry, true, "an offline send left no retry affordance");
					report.ok("E14.1 — a send with the network down fails honestly in the transcript instead of spinning.");
				} finally {
					// The wire goes back up even when the row failed; the retry row
					// below and anything after it need a working network.
					await session.send("Network.emulateNetworkConditions", {
						offline: false,
						latency: 0,
						downloadThroughput: -1,
						uploadThroughput: -1,
					});
				}
			});

			if (!wentOffline) {
				skipSection("E14.1 (retry after reconnect)", "the offline send left no failed turn to retry");
			} else {
				await section("E14.1 (retry after reconnect)", async () => {
					const beforeReconnect = await evaluate<string>(`document.querySelector('[data-slot="chat-transcript"]').innerText`);
					await evaluate(`(() => { const buttons = Array.from(document.querySelectorAll('[aria-label=${JSON.stringify(RETRY_LABEL)}]')); buttons[buttons.length - 1].click(); return true; })()`);
					await waitUntil(
						report,
						"the reconnected retry never completed",
						async () => {
							const probe = await evaluate<A11yProbe>(A11Y_PROBE);
							return (
								probe.transcriptBusy === "false" &&
								probe.pendingRole === null &&
								probe.transcript.length > beforeReconnect.length &&
								probe.transcript.slice(beforeReconnect.length).includes(STUB_REPLY)
							);
						},
						45_000,
					);
					report.ok("E14.1 — once the network is back, the same retry affordance completes the turn the outage killed.");
				});
			}
		};

		if (session === null) {
			for (const label of SIGNED_IN_SECTIONS) {
				skipSection(label, "the signed-in session never opened");
			}
		} else {
			try {
				await signedIn(session);
			} finally {
				session.close();
			}
		}

		const passed = outcomes.filter((outcome) => outcome.state === "passed");
		const failed = outcomes.filter((outcome) => outcome.state === "failed");
		const skipped = outcomes.filter((outcome) => outcome.state === "skipped");
		console.log(
			`sections: E13-E14 — ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, of ${outcomes.length} run to completion.`,
		);
		if (failed.length > 0 || skipped.length > 0) {
			report.fail(
				[...failed, ...skipped].map((outcome) => `${outcome.state} ${outcome.label}: ${outcome.reason}`).join(" ;; "),
			);
		}
	},
});
