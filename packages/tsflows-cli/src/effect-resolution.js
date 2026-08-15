/**
 * Installs the process-wide module resolver required by BUILD.ts evaluation.
 *
 * Rules, the planner, and the flow engine exchange values branded by Effect's
 * runtime symbols. A linked workspace can otherwise load another physical
 * `effect` installation—even at the same version—and hand the engine schemas
 * it cannot interpret. BUILD.ts modules therefore resolve every `effect` bare
 * import from the CLI package that owns the runtime. BUILD.ts is also always
 * an ES module, independent of the nearest package.json `type`: declaration
 * semantics must not change because a package publishes CommonJS.
 *
 * @since 0.1.0
 */
import { registerHooks } from "node:module"

const installation = Symbol.for("tsflows-cli/effect-resolution-installed")
const buildModuleParameter = "tsflows-build-module"

const isBuildModule = (url) => {
  if (!url.startsWith("file:")) return false
  const parsed = new URL(url)
  return parsed.searchParams.get(buildModuleParameter) === "1" || parsed.pathname.endsWith("/BUILD.ts")
}

/** Installs the resolver once per process. */
export const installEffectResolution = () => {
  if (globalThis[installation] === true) return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = specifier === "effect" || specifier.startsWith("effect/")
        ? nextResolve(specifier, { ...context, parentURL: import.meta.url })
        : nextResolve(specifier, context)
      return isBuildModule(resolved.url) ? { ...resolved, format: "module" } : resolved
    }
  })
  Object.defineProperty(globalThis, installation, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
}

/** Marks one admitted BUILD.ts URL for ES-module evaluation. */
export const buildModuleUrl = (url) => {
  const marked = new URL(url)
  marked.searchParams.set(buildModuleParameter, "1")
  return marked.href
}
