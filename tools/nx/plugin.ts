/**
 * Local Nx plugin for the flows workspace.
 *
 * Two jobs the shipped inference plugins cannot do, because both are flows
 * conventions rather than ecosystem conventions:
 *
 * 1. Tags. Every package manifest carries `smthrs.group`
 *    (`engine` / `agent` / `tooling`), the repository's dependency tier. The
 *    plugin maps it onto `group:<tier>` tags so `@nx/enforce-module-boundaries`
 *    can encode the release-train constraint (see `eslint.boundaries.js`).
 *    Apps get `type:app`, packages `type:package`.
 *
 * 2. dprint. The repository lint gate is `eslint src --max-warnings=0 &&
 *    dprint check`. ESLint targets come from the package `lint` script (the
 *    `@nx/eslint` inference command, `eslint .`, does not fit these flat
 *    configs); the dprint half is inferred here as a cacheable `fmt` target
 *    from the presence of `dprint.json`.
 */
import { readJsonFile, type CreateNodesV2 } from "@nx/devkit"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export const createNodesV2: CreateNodesV2 = [
  "{packages/*,packages/build/infra,apps/*,examples}/package.json",
  (configFiles, _options, context) => {
    return configFiles.map((configFile) => {
      const projectRoot = dirname(configFile)
      const manifest = readJsonFile(join(context.workspaceRoot, configFile)) as {
        readonly smthrs?: { readonly group?: string }
      }

      const tags: Array<string> = []
      const group = manifest.smthrs?.group
      if (group === "engine" || group === "agent" || group === "tooling") {
        tags.push(`group:${group}`)
      }
      tags.push(projectRoot.startsWith("apps/") ? "type:app" : "type:package")

      const targets: Record<string, unknown> = {}
      if (existsSync(join(context.workspaceRoot, projectRoot, "dprint.json"))) {
        targets["fmt"] = {
          command: "dprint check",
          options: { cwd: projectRoot },
          cache: true,
          inputs: ["default"],
          metadata: {
            technologies: ["dprint"],
            description: "Checks formatting with dprint."
          }
        }
      }

      return [
        configFile,
        {
          projects: {
            [projectRoot]: {
              tags,
              targets
            }
          }
        }
      ]
    })
  }
]
