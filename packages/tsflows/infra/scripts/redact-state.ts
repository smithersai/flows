import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const redacted = "__TSFLOWS_CACHE_TOKEN_REDACTED__"
const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const stateDirectory = NodePath.join(infraDirectory, ".alchemy", "state", "TsflowsRemoteCache")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const redactWorkerState = (value: unknown, bearerToken: string | undefined): boolean => {
  if (!isRecord(value)) return false
  let changed = false

  const props = isRecord(value["props"]) ? value["props"] : null
  const env = props !== null && isRecord(props["env"]) ? props["env"] : null
  const token = env !== null && isRecord(env["CACHE_TOKEN"]) ? env["CACHE_TOKEN"] : null
  if (
    token !== null &&
    bearerToken !== undefined &&
    token["__redacted__"] === bearerToken
  ) {
    changed = true
    token["__redacted__"] = redacted
  }

  const bindings = value["bindings"]
  if (!Array.isArray(bindings)) return changed
  for (const binding of bindings) {
    if (!isRecord(binding) || binding["sid"] !== "CACHE_TOKEN") continue
    const data = isRecord(binding["data"]) ? binding["data"] : null
    const nativeBindings = data?.["bindings"]
    if (!Array.isArray(nativeBindings)) continue
    for (const nativeBinding of nativeBindings) {
      if (
        !isRecord(nativeBinding) ||
        nativeBinding["type"] !== "secret_text" ||
        nativeBinding["name"] !== "CACHE_TOKEN" ||
        typeof nativeBinding["text"] !== "string"
      ) {
        continue
      }
      if (bearerToken !== undefined && nativeBinding["text"] === bearerToken) {
        changed = true
        nativeBinding["text"] = redacted
      }
    }
  }
  return changed
}

const redactFile = async (file: string): Promise<boolean> => {
  const text = await Fs.readFile(file, "utf8")
  const state: unknown = JSON.parse(text)
  if (!redactWorkerState(state, process.env["TSFLOWS_CACHE_TOKEN"])) return false
  const temporary = `${file}.${process.pid.toString(36)}.tmp`
  try {
    await Fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await Fs.rename(temporary, file)
  } catch (error) {
    await Fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return true
}

/**
 * Removes the Worker bearer value that Alchemy local state serializes inside
 * otherwise-redacted binding records.
 *
 * @category security
 * @since 0.1.0
 */
export const redactAlchemyState = async (): Promise<number> => {
  let entries: Array<string>
  try {
    entries = await Fs.readdir(stateDirectory, { recursive: true })
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return 0
    throw error
  }
  const workerStates = entries
    .filter((entry) => NodePath.basename(entry) === "CacheWorker.json")
    .map((entry) => NodePath.join(stateDirectory, entry))
  const results = await Promise.all(workerStates.map(redactFile))
  return results.filter(Boolean).length
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const count = await redactAlchemyState()
    process.stdout.write(`Redacted ${count} Alchemy Worker state file(s).\n`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
