import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeExternalHref, resolveDocLink } from "../ui/ddd-shared.tsx";
import { trustedGatewayUrl } from "../workflows/create-ui.tsx";
import { evalCaseIdentity, suiteSchema } from "../workflows/eval-suite-run.tsx";
import { isSafeRelativeArchitecturePath, resolveArchitectureSitePath } from "../workflows/production-readiness-swarm.tsx";
import { claimPreparedStagingRoot, resolveOwnedStagingRoot } from "../workflows/share-pack.tsx";
import { safeWorkflowSlug } from "../workflows/create-workflow.tsx";
import { trustedWorkflowSourcePath } from "../workflows/post-failure.tsx";
import { assertTokenSafeWebhookDestination } from "../workflows/whole-foods-meal-planner.tsx";

const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  delete process.env.SMITHERS_GATEWAY_URL;
});

describe("workflow security guards", () => {
  test("gateway verification is bound to the configured origin", () => {
    process.env.SMITHERS_GATEWAY_URL = "https://gateway.example";
    expect(trustedGatewayUrl("https://gateway.example")).toBe("https://gateway.example");
    expect(() => trustedGatewayUrl("http://169.254.169.254")).toThrow();
    expect(() => trustedGatewayUrl("https://user@gateway.example")).toThrow();
    expect(() => trustedGatewayUrl("https://gateway.example/redirect")).toThrow();
  });

  test("eval suite identities are safe, unique, and index-stable", () => {
    const base = { suiteId: "s", name: "suite", workflowKey: "w", workflowPath: "w.tsx", workflowRoot: "." };
    expect(() => suiteSchema.parse({ ...base, cases: [{ id: "same", input: 1 }, { id: "same", input: 2 }] })).toThrow();
    expect(() => suiteSchema.parse({ ...base, cases: [{ id: "../escape", input: 1 }] })).toThrow();
    expect(evalCaseIdentity("case", 2)).toBe("2-case");
  });

  test("architecture paths cannot escape or traverse symlinks", () => {
    expect(isSafeRelativeArchitecturePath("docs/architecture")).toBe(true);
    for (const value of ["../outside", "/tmp/outside", "docs/../outside", "docs\\outside", ""]) {
      expect(isSafeRelativeArchitecturePath(value)).toBe(false);
    }
    const root = mkdtempSync(join(tmpdir(), "architecture-root-"));
    temporaryRoots.push(root);
    symlinkSync(tmpdir(), join(root, "linked"));
    expect(() => resolveArchitectureSitePath(root, "linked/site")).toThrow();
  });

  test("share cleanup requires a run-owned temp marker", () => {
    const prepared = mkdtempSync(join(tmpdir(), "smithers-share-stage-"));
    const stagingId = claimPreparedStagingRoot(prepared, "run-a");
    const owned = resolveOwnedStagingRoot(stagingId, "run-a");
    temporaryRoots.push(owned.parent);
    expect(owned.staging.startsWith(owned.parent)).toBe(true);
    expect(() => resolveOwnedStagingRoot(stagingId, "run-b")).toThrow();
    expect(() => resolveOwnedStagingRoot("../../tmp", "run-a")).toThrow();
  });

  test("documentation links allow only narrow external schemes", () => {
    expect(safeExternalHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeExternalHref("mailto:user@example.com")).toBe("mailto:user@example.com");
    for (const value of ["javascript:alert(1)", "javascript://alert(1)", "JaVaScRiPt://alert(1)", "data:text/html,x", "javascript%3Aalert(1)"]) {
      expect(safeExternalHref(value)).toBeNull();
      expect(resolveDocLink("docs/index.md", value, () => false)).toBeNull();
    }
  });

  test("agent-derived workflow names use the same slug contract", () => {
    expect(safeWorkflowSlug("safe-workflow")).toBe("safe-workflow");
    for (const value of ["../escape", "nested/name", "UpperCase", "", "."]) expect(() => safeWorkflowSlug(value)).toThrow();
  });

  test("post-failure source reads stay inside real workflow roots", () => {
    const root = mkdtempSync(join(tmpdir(), "post-failure-root-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, ".smithers", "workflows"), { recursive: true });
    writeFileSync(join(root, ".smithers", "workflows", "safe.tsx"), "export default 1");
    writeFileSync(join(root, "secret.tsx"), "secret");
    symlinkSync(join(root, "secret.tsx"), join(root, ".smithers", "workflows", "linked.tsx"));
    expect(trustedWorkflowSourcePath(".smithers/workflows/safe.tsx", root)).toEndWith("safe.tsx");
    expect(trustedWorkflowSourcePath("secret.tsx", root)).toBeNull();
    expect(trustedWorkflowSourcePath(".smithers/workflows/linked.tsx", root)).toBeNull();
  });

  test("bearer-token webhooks cannot rely on re-resolvable DNS", async () => {
    await expect(assertTokenSafeWebhookDestination("https://attacker.example/order", "secret")).rejects.toThrow("IP-literal");
    await expect(assertTokenSafeWebhookDestination("https://127.0.0.1/order", "secret")).rejects.toThrow("non-public");
  });
});
