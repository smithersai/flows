/*
 * The tool-echo scrub: a weak model sometimes writes its tool call INTO the
 * reply text — `{"action":"execute","name":"repos.watch","args":""}` rendered
 * as prose — instead of emitting it on the tool channel. That text is wire
 * debris, never legitimate prose, so the renderer strips it. The STORE keeps
 * the raw text (the dev-tools panel shows the truth); only the bubble is
 * scrubbed. Nothing here ever EXECUTES a scrubbed blob: text is not a tool
 * call, and treating it as one would open a prompt-injection door.
 */

const TOOL_ECHO_STARTS = ['{"action"', '{ "action"'] as const;

/** The end of the JSON object opening at `start`, or undefined when unbalanced. */
const balancedEnd = (text: string, start: number): number | undefined => {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index += 1;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return undefined;
};

/** True when the blob parses and looks like a commands-tool call. */
const isToolEcho = (blob: string): boolean => {
	try {
		const parsed: unknown = JSON.parse(blob);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"action" in parsed &&
			(parsed.action === "execute" || parsed.action === "list")
		);
	} catch {
		return false;
	}
};

export const scrubToolEcho = (text: string): string => {
	let out = text;
	for (const starter of TOOL_ECHO_STARTS) {
		let cursor = out.indexOf(starter);
		while (cursor !== -1) {
			const end = balancedEnd(out, cursor);
			if (end !== undefined && isToolEcho(out.slice(cursor, end))) {
				out = `${out.slice(0, cursor)}${out.slice(end)}`;
				cursor = out.indexOf(starter, cursor);
			} else {
				cursor = out.indexOf(starter, cursor + 1);
			}
		}
	}
	// Collapse the seams a removal leaves behind, without touching real prose.
	return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
};

/*
 * The act row's detail (will, 2026-08-19): "This is cool but I can't click on
 * it or hover to see more".
 *
 * The one-line marker keeps saying only what it always said; the DETAIL is
 * what a hover and an expansion show. It travels under the same rule as the
 * visible line — §2b: raw payloads never enter the conversation — so a value
 * that is a JSON blob is NAMED rather than pasted, whitespace is collapsed to
 * one line, and the whole thing is bounded. A detail is evidence, not an
 * inspector; the dev-tools panel still holds the full record.
 */

/** Past this a detail is a payload dump, not a line the user reads on hover. */
export const MAX_ACT_DETAIL = 320;

const looksStructured = (value: string): boolean => {
	const head = value.trimStart();
	return head.startsWith("{") || head.startsWith("[");
};

/** One line, collapsed and bounded, with the ellipsis inside the budget. */
const bounded = (value: string, max: number): string => {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/**
 * One field of an act's detail: the caller's own words when they are words,
 * and what the value IS when it is a payload.
 *
 * @category conversions
 */
export const actDetailField = (value: string, max = MAX_ACT_DETAIL): string => {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	if (looksStructured(trimmed)) {
		/*
		 * A structured argument is still worth naming: the model's own call
		 * carries the flow name and its argument text, and those two ARE the
		 * detail will asked for. Anything else in the blob stays in dev-tools.
		 */
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const fields = Object.entries(parsed as Record<string, unknown>)
					.filter(([, entry]) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")
					.map(([key, entry]) => `${key} ${String(entry)}`);
				if (fields.length > 0) return bounded(fields.join(", "), max);
			}
		} catch {
			// Not JSON after all; it is still not prose.
		}
		return "";
	}
	return bounded(trimmed, max);
};

/**
 * The detail an act row carries, assembled from parts and bounded as a whole.
 * Empty parts drop out, and an act with nothing to add carries no detail at
 * all — an honest empty state, never an invented one.
 *
 * @category conversions
 */
export const actDetail = (parts: ReadonlyArray<string>): string | undefined => {
	const kept = parts.map((part) => part.trim()).filter((part) => part !== "");
	if (kept.length === 0) return undefined;
	return bounded(kept.join(" · "), MAX_ACT_DETAIL);
};
