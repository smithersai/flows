import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The gateway serves a workflow's browser UI only if the workflow is in its
 * mount table. A workflow that declares <UI …> and is announced in the pack
 * manifest but is missing from that table registers nowhere, so the UI the
 * manifest promises 404s while startup still reports healthy. These read the
 * three declarations against each other so the omission fails here instead.
 */

const packRoot = fileURLToPath(new URL("..", import.meta.url));

const gatewaySource = readFileSync(`${packRoot}gateway.ts`, "utf8");
const manifest = readFileSync(`${packRoot}smithers.toon`, "utf8");

/** The keys the gateway's mount table names. */
const mountedKeys = [...gatewaySource.matchAll(/\{\s*key:\s*"([^"]+)"/g)].map((match) => match[1]);

/** Every workflow whose source declares a browser UI entry. */
const uiDeclaringWorkflows = readdirSync(`${packRoot}workflows`)
	.filter((file) => file.endsWith(".tsx"))
	.filter((file) => /<UI\s+entry=/.test(readFileSync(`${packRoot}workflows/${file}`, "utf8")))
	.map((file) => file.replace(/\.tsx$/, ""))
	.sort();

describe("gateway mount table", () => {
	test("every workflow that declares a UI is mounted", () => {
		expect(mountedKeys.length).toBeGreaterThan(0);
		expect([...mountedKeys].sort()).toEqual(uiDeclaringWorkflows);
	});

	test("the manifest's ui list is exactly what the gateway mounts", () => {
		const declared = manifest.match(/^\s*ui\[\d+\]:\s*(.+)$/m)?.[1] ?? "";
		expect(declared.split(",").map((key) => key.trim()).sort()).toEqual([...mountedKeys].sort());
	});

	test("every mount is classified, and a required one that fails stops startup", () => {
		expect(mountedKeys.length).toBe(gatewaySource.match(/required:\s*(true|false)/g)?.length);
		expect(gatewaySource).toContain("process.exit(1)");
	});
});
