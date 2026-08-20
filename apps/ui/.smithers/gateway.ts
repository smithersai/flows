import { Gateway, mdxPlugin } from "smthrs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
process.chdir(projectRoot);

const parsedPort = Number(process.env.PORT ?? "7331");
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";

const gateway = new Gateway({ heartbeatMs: 15_000 });

// Mount each workflow independently. Browser UIs are declared by each workflow
// with <UI entry="../ui/<key>.tsx" /> and discovered by Gateway.register().
// Mounts are classified: every workflow this pack ships is REQUIRED here — the
// gateway coming up "healthy" without one hides a broken pack behind a 200, so
// a failed required registration fails startup instead of being warned away.
async function mountWorkflow(key: string, title: string, required: boolean): Promise<boolean> {
  try {
    const workflowEntry = resolve(here, "workflows", key + ".tsx");
    const mod = await import("./workflows/" + key + ".tsx");
    gateway.register(key, mod.default, { entryFile: workflowEntry });
    const mounted = (gateway as any).workflows?.get?.(key)?.ui;
    if (mounted) {
      console.log("  " + title + " UI -> http://" + host + ":" + port + "/workflows/" + key);
    } else {
      console.log("  " + title + " (no UI)");
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (required) {
      console.error("[gateway] REQUIRED workflow " + key + " failed to register: " + message);
    } else {
      console.warn("[gateway] skipped optional workflow " + key + ": " + message);
    }
    return false;
  }
}

const mounts: ReadonlyArray<{ readonly key: string; readonly title: string; readonly required: boolean }> = [
  { key: "create-workflow", title: "Create Workflow", required: true },
  { key: "create-skill", title: "Create Skill", required: true },
  { key: "docs-driven-development", title: "Docs Driven Development", required: true },
  { key: "production-readiness-swarm", title: "Production Readiness Swarm", required: true },
  { key: "share-pack", title: "Share Pack", required: true },
  { key: "smithers-repo-federation", title: "Smithers Repo Federation", required: true },
  { key: "whole-foods-meal-planner", title: "Whole Foods Meal Planner", required: true },
];

console.log("Workflow UIs:");
const failedRequired: Array<string> = [];
for (const mount of mounts) {
  const mounted = await mountWorkflow(mount.key, mount.title, mount.required);
  if (mount.required && !mounted) failedRequired.push(mount.key);
}

// Readiness is the mount record, not the listening socket: a required workflow
// that never registered means the gateway is not ready to serve, so refuse to
// come up rather than report healthy with a workflow silently missing.
if (failedRequired.length > 0) {
  console.error(
    "[gateway] not ready: " + failedRequired.length + " required workflow(s) failed to register: " +
      failedRequired.join(", "),
  );
  process.exit(1);
}

await gateway.listen({ host, port });
console.log("Smithers Gateway listening on http://" + host + ":" + port);
