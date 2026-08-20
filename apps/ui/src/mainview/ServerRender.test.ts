import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/*
 * The Start entry renders `routes/__root.tsx` on the SERVER, so every module
 * that route imports has to evaluate with no DOM. The boot chain does not:
 * `ControllerBoot.client` reaches `electrobun/view`, whose module body reads
 * `window` as it evaluates. Importing it statically from ControllerProvider
 * threw "window is not defined" before a component ever ran — the SPA entry
 * and the unit suite both have a DOM, so nothing else in this repo notices.
 *
 * The check runs in a child process precisely because this suite registers a
 * happy-dom global: a DOM-free import is the whole assertion, and it cannot be
 * made inside a process that has one.
 */

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

const importsWithoutDom = async (specifier: string): Promise<{ code: number; stderr: string }> => {
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", `await import(${JSON.stringify(specifier)});`],
		cwd: appRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { code, stderr };
};

describe("the server-rendered route graph evaluates without a DOM", () => {
	test("ControllerProvider imports with no window", async () => {
		const result = await importsWithoutDom("./src/mainview/ControllerProvider.tsx");
		expect(result.stderr).not.toContain("window is not defined");
		expect(result.code).toBe(0);
	});

	test("the boot module is the browser-only half, and stays out of the static graph", async () => {
		// Stated as a fact, not an aspiration: this is WHY the import above is dynamic.
		const result = await importsWithoutDom("./src/mainview/ControllerBoot.client.ts");
		expect(result.code).not.toBe(0);
	});
});
