/**
 * The HTTP protocol shared by the hosted and self-hosted cache backends.
 *
 * @since 0.1.0
 */

const hexDigest = /^[0-9a-f]{64}$/
const jsonContentType = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/
const decimalDigits = /^[0-9]+$/
const controlCharacters = /[\u0000-\u001f\u007f]/

/**
 * The largest action-cache document the service accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxActionCacheBodyBytes = 1024 * 1024

/**
 * The largest `findMissing` request the service accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxFindMissingBodyBytes = 256 * 1024

/**
 * The most digests one `findMissing` request may probe.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxFindMissingDigests = 1000

/**
 * The longest action-cache key or journal run identifier the service stores.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxKeyDigestLength = 512

/**
 * The most artifact references one publication records.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxReferencedDigests = 1000

/**
 * The absolute per-artifact ceiling supported by both cache deployments.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxArtifactBodyBytes = 16 * 1024 * 1024

/**
 * The deepest and widest JSON document accepted by the action cache.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxJsonDepth = 64

/**
 * The total number of object members and array elements accepted per document.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxJsonMembers = 100_000

/**
 * The largest canonical conflict discriminator retained in memory.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxCanonicalJsonBytes = 2 * 1024 * 1024

/**
 * The maximum number of chunks accepted for one bounded body.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxBodyChunks = 16_384

/**
 * The maximum number of requests admitted by one Worker isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentCacheRequests = 64

/**
 * The maximum number of large CAS transfers admitted by one Worker isolate.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxConcurrentArtifactTransfers = 4

/**
 * Successful readiness checks are coalesced for this monotonic interval.
 *
 * @category constants
 * @since 0.1.0
 */
export const healthCacheMilliseconds = 1000

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

type Publication = "inserted" | "identical" | "conflict"

/**
 * Optional journal provenance used to fence action-cache deletion.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeleteFence {
  readonly runId: string
  readonly eventSeq: number
}

/**
 * One validated action-cache publication.
 *
 * `body` is the exact JSON text supplied by the client. `resultJson` is a
 * canonical conflict discriminator: the entry's `result` member when it has
 * one, or the entire JSON value for the CLI's `CachedResult` shape.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActionCachePublication {
  readonly body: string
  readonly resultJson: string
  readonly createdAtMs: number | null
  readonly recordedRunId: string | null
  readonly recordedEventSeq: number | null
  readonly digests: readonly string[]
}

/**
 * Storage operations required by the `/ac` protocol.
 *
 * @category services
 * @since 0.1.0
 */
export interface ActionCache {
  readonly get: (keyDigest: string) => Promise<string | null>
  readonly put: (
    keyDigest: string,
    publication: ActionCachePublication
  ) => Promise<Publication>
  readonly delete: (keyDigest: string, fence: DeleteFence | null) => Promise<boolean>
}

/**
 * One content-addressed object returned by the backing store.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContentObject {
  readonly body: BodyInit
}

/**
 * Storage operations required by the `/cas` protocol.
 *
 * @category services
 * @since 0.1.0
 */
export interface ContentStore {
  readonly get: (digest: string) => Promise<ContentObject | null>
  readonly has: (digest: string) => Promise<boolean>
  readonly put: (
    digest: string,
    bytes: Uint8Array<ArrayBuffer>
  ) => Promise<"inserted" | "present">
  readonly presentDigests: (digests: readonly string[]) => Promise<ReadonlySet<string>>
}

/**
 * Dependencies for the remote-cache protocol handler.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProtocolDependencies {
  readonly actionCache: ActionCache
  readonly contentStore: ContentStore
  readonly tokenHash: string
  readonly health?: () => Promise<void>
  readonly maxArtifactBytes?: number
}

type BodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly response: Response }

type JsonRead =
  | { readonly ok: true; readonly text: string; readonly value: unknown }
  | { readonly ok: false; readonly response: Response }

type PublicationRead =
  | { readonly ok: true; readonly publication: ActionCachePublication }
  | { readonly ok: false; readonly response: Response }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const empty = (status: number): Response => new Response(null, { status })

const busy = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" }
  })

const methodNotAllowed = (allowed: string): Response =>
  new Response(null, { status: 405, headers: { allow: allowed } })

const mediaType = (request: Request): string =>
  (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""

const utf8Bytes = (value: string): number => textEncoder.encode(value).byteLength

/** Cancels a body the handler has refused without allowing cleanup to mask the response. */
const discardBody = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (body === null) return
  try {
    await body.cancel()
  } catch {
    // A sender that has already gone away needs no further cleanup.
  }
}

const readBody = async (request: Request, limit: number): Promise<BodyRead> => {
  const contentLength = request.headers.get("content-length")
  let declaredLength: number | null = null
  if (contentLength !== null) {
    if (!decimalDigits.test(contentLength)) {
      await discardBody(request.body)
      return { ok: false, response: json(400, { error: "invalid content-length" }) }
    }
    declaredLength = Number(contentLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > limit) {
      await discardBody(request.body)
      return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
    }
  }

  if (request.body === null) {
    return declaredLength === null || declaredLength === 0
      ? { ok: true, bytes: new Uint8Array() }
      : { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }

  const reader = request.body.getReader()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // A reader that cannot be released is already unusable; the answer stands.
    }
  }
  const abandon = async (): Promise<void> => {
    try {
      await reader.cancel()
    } catch {
      // Cancellation is best effort and must not replace the client-facing error.
    }
    release()
  }

  const bytes = new Uint8Array(declaredLength ?? limit)
  let length = 0
  let chunks = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks += 1
      if (chunks > maxBodyChunks) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body has too many chunks" }) }
      }
      if (!(chunk.value instanceof Uint8Array)) {
        await abandon()
        return { ok: false, response: json(400, { error: "request body must be a byte stream" }) }
      }
      if (chunk.value.byteLength === 0) continue
      if (length + chunk.value.byteLength > limit) {
        await abandon()
        return { ok: false, response: json(413, { error: "request body exceeds the configured bound" }) }
      }
      if (length + chunk.value.byteLength > bytes.byteLength) {
        await abandon()
        return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
      }
      bytes.set(chunk.value, length)
      length += chunk.value.byteLength
    }
  } catch (cause) {
    await abandon()
    throw cause
  }
  release()

  if (declaredLength !== null && length !== declaredLength) {
    return { ok: false, response: json(400, { error: "content-length does not match the request body" }) }
  }
  return { ok: true, bytes: bytes.subarray(0, length) }
}

const readJson = async (request: Request, limit: number): Promise<JsonRead> => {
  if (!jsonContentType.test(mediaType(request))) {
    await discardBody(request.body)
    return { ok: false, response: json(415, { error: "content-type must be application/json" }) }
  }
  const body = await readBody(request, limit)
  if (!body.ok) return body
  let text: string
  try {
    text = textDecoder.decode(body.bytes)
  } catch {
    return { ok: false, response: json(400, { error: "body must be UTF-8 JSON" }) }
  }
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, text, value }
  } catch {
    return { ok: false, response: json(400, { error: "body must be valid JSON" }) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const renderCanonicalJson = (value: unknown): string => {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number is outside the supported range")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(renderCanonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${
      Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${renderCanonicalJson(value[key])}`)
        .join(",")
    }}`
  }
  throw new Error("unsupported JSON value")
}

/**
 * Renders an inert JSON value with deterministic member order and hard bounds.
 *
 * @category utilities
 * @since 0.1.0
 */
export const canonicalJson = (value: unknown): string => {
  const ancestors = new Set<object>()
  let members = 0
  const validate = (current: unknown, depth: number): void => {
    if (depth > maxJsonDepth) throw new Error("JSON is nested too deeply")
    if (current === null || typeof current === "string" || typeof current === "boolean") return
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new Error("JSON number is outside the supported range")
      }
      return
    }
    if (!Array.isArray(current) && !isRecord(current)) throw new Error("unsupported JSON value")
    if (ancestors.has(current)) throw new Error("JSON contains a cycle")
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current).filter((key) => key !== "length")
        if (keys.length !== current.length) throw new Error("array is not a JSON array")
        if (current.length > maxJsonMembers - members) throw new Error("JSON has too many members")
        members += current.length
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            throw new Error("array is not an inert JSON array")
          }
          validate(descriptor.value, depth + 1)
        }
        return
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("object is not a JSON object")
      }
      const keys = Reflect.ownKeys(current)
      if (!keys.every((key) => typeof key === "string")) throw new Error("object has symbol keys")
      if (keys.length > maxJsonMembers - members) throw new Error("JSON has too many members")
      members += keys.length
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("object is not an inert JSON object")
        }
        validate(descriptor.value, depth + 1)
      }
    } finally {
      ancestors.delete(current)
    }
  }

  validate(value, 0)
  const rendered = renderCanonicalJson(value)
  if (utf8Bytes(rendered) > maxCanonicalJsonBytes) {
    throw new Error("canonical JSON exceeds its byte bound")
  }
  return rendered
}

const invalidKeyDigest = (keyDigest: string): string | null => {
  if (keyDigest.length === 0) return "empty keyDigest"
  if (utf8Bytes(keyDigest) > maxKeyDigestLength) {
    return `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`
  }
  if (controlCharacters.test(keyDigest)) return "keyDigest must not contain control characters"
  return null
}

const referencedDigests = (record: Record<string, unknown>): readonly string[] => {
  const meta = isRecord(record["meta"]) ? record["meta"] : null
  const boundary = meta !== null && isRecord(meta["boundary"]) ? meta["boundary"] : null
  const declaredOutputs = boundary !== null && isRecord(boundary["declaredOutputs"])
    ? boundary["declaredOutputs"]
    : null
  const outputs = declaredOutputs?.["outputs"]
  if (outputs === undefined) return []
  if (!Array.isArray(outputs)) throw new Error("declared outputs must be an array")
  const references = new Set<string>()
  for (const output of outputs) {
    if (!isRecord(output)) throw new Error("declared output must be an object")
    if (!Object.hasOwn(output, "digest") || output["digest"] === null || Object.hasOwn(output, "content")) {
      continue
    }
    const digest = output["digest"]
    if (typeof digest !== "string" || !hexDigest.test(digest)) {
      throw new Error("declared output digest is invalid")
    }
    references.add(digest)
    if (references.size > maxReferencedDigests) {
      throw new Error("publication references too many artifacts")
    }
  }
  return [...references]
}

const readPublication = async (request: Request, keyDigest: string): Promise<PublicationRead> => {
  const parsed = await readJson(request, maxActionCacheBodyBytes)
  if (!parsed.ok) return parsed
  const record = isRecord(parsed.value) ? parsed.value : null
  if (record !== null && Object.hasOwn(record, "keyDigest") && record["keyDigest"] !== keyDigest) {
    return {
      ok: false,
      response: json(400, { error: "keyDigest must match the request path when supplied" })
    }
  }

  const enveloped = record !== null && Object.hasOwn(record, "keyDigest") && Object.hasOwn(record, "result")
  let resultJson: string
  let digests: readonly string[]
  try {
    canonicalJson(parsed.value)
    resultJson = canonicalJson(enveloped ? record["result"] : parsed.value)
    digests = enveloped ? referencedDigests(record) : []
  } catch {
    return {
      ok: false,
      response: json(400, { error: "body contains invalid or unsupported cache metadata" })
    }
  }

  const metadata = enveloped ? record : null
  const hasCreatedAtMs = metadata !== null && Object.hasOwn(metadata, "createdAtMs")
  const createdAtMs = hasCreatedAtMs ? metadata["createdAtMs"] : null
  if (hasCreatedAtMs && (!Number.isSafeInteger(createdAtMs) || (createdAtMs as number) < 0)) {
    return {
      ok: false,
      response: json(400, { error: "createdAtMs must be a non-negative safe integer" })
    }
  }

  const hasRecordedRunId = metadata !== null && Object.hasOwn(metadata, "recordedRunId")
  const hasRecordedEventSeq = metadata !== null && Object.hasOwn(metadata, "recordedEventSeq")
  if (hasRecordedRunId !== hasRecordedEventSeq) {
    return {
      ok: false,
      response: json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
  }
  const recordedRunId = hasRecordedRunId ? metadata["recordedRunId"] : null
  const recordedEventSeq = hasRecordedEventSeq ? metadata["recordedEventSeq"] : null
  if (
    hasRecordedRunId &&
    (typeof recordedRunId !== "string" ||
      recordedRunId.length === 0 ||
      utf8Bytes(recordedRunId) > maxKeyDigestLength ||
      controlCharacters.test(recordedRunId) ||
      !Number.isSafeInteger(recordedEventSeq) ||
      (recordedEventSeq as number) < 0)
  ) {
    return { ok: false, response: json(400, { error: "publication provenance is invalid" }) }
  }

  return {
    ok: true,
    publication: {
      body: parsed.text,
      resultJson,
      createdAtMs: hasCreatedAtMs ? (createdAtMs as number) : null,
      recordedRunId: hasRecordedRunId ? (recordedRunId as string) : null,
      recordedEventSeq: hasRecordedEventSeq ? (recordedEventSeq as number) : null,
      digests
    }
  }
}

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const bearerScheme = /^Bearer +/i

const authorized = async (request: Request, expected: Uint8Array<ArrayBuffer>): Promise<boolean> => {
  const authorization = request.headers.get("authorization") ?? ""
  const scheme = bearerScheme.exec(authorization)
  const bearer = scheme !== null
  const suppliedToken = bearer ? authorization.slice(scheme[0].length) : ""
  const suppliedDigest = await crypto.subtle.digest("SHA-256", textEncoder.encode(suppliedToken))
  const supplied = new Uint8Array(suppliedDigest)
  let difference = 0
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0)
  }
  return bearer && difference === 0
}

const handleActionCache = async (
  request: Request,
  keyDigest: string,
  url: URL,
  actionCache: ActionCache
): Promise<Response> => {
  const problem = invalidKeyDigest(keyDigest)
  if (problem !== null) {
    await discardBody(request.body)
    return json(400, { error: problem })
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    const body = await actionCache.get(keyDigest)
    return body === null
      ? empty(404)
      : new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }
  if (request.method === "PUT") {
    const publication = await readPublication(request, keyDigest)
    if (!publication.ok) return publication.response
    const result = await actionCache.put(keyDigest, publication.publication)
    if (result === "inserted") return json(201, { keyDigest })
    return empty(result === "identical" ? 200 : 409)
  }
  if (request.method === "DELETE") {
    await discardBody(request.body)
    const runIds = url.searchParams.getAll("recordedRunId")
    const eventSeqs = url.searchParams.getAll("recordedEventSeq")
    if (runIds.length > 1 || eventSeqs.length > 1) {
      return json(400, { error: "deletion fence parameters must not be repeated" })
    }
    const runId = runIds[0] ?? null
    const eventSeq = eventSeqs[0] ?? null
    if ((runId === null) !== (eventSeq === null)) {
      return json(400, {
        error: "recordedRunId and recordedEventSeq must be supplied together"
      })
    }
    let fence: DeleteFence | null = null
    if (runId !== null && eventSeq !== null) {
      if (runId.length === 0 || utf8Bytes(runId) > maxKeyDigestLength || controlCharacters.test(runId)) {
        return json(400, { error: "recordedRunId must be a non-empty bounded string" })
      }
      const parsedEventSeq = Number(eventSeq)
      if (!decimalDigits.test(eventSeq) || !Number.isSafeInteger(parsedEventSeq)) {
        return json(400, {
          error: "recordedEventSeq must be a non-negative safe integer"
        })
      }
      fence = { runId, eventSeq: parsedEventSeq }
    }
    return empty((await actionCache.delete(keyDigest, fence)) ? 200 : 404)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, PUT, DELETE")
}

const handleArtifact = async (
  request: Request,
  digest: string,
  contentStore: ContentStore,
  maxArtifactBytes: number
): Promise<Response> => {
  if (!hexDigest.test(digest)) {
    await discardBody(request.body)
    return json(400, { error: "digest must be 64 lowercase hex characters" })
  }
  if (request.method === "HEAD") {
    await discardBody(request.body)
    return empty((await contentStore.has(digest)) ? 200 : 404)
  }
  if (request.method === "GET") {
    await discardBody(request.body)
    const object = await contentStore.get(digest)
    return object === null
      ? empty(404)
      : new Response(object.body, {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      })
  }
  if (request.method === "PUT") {
    if (mediaType(request) !== "application/octet-stream") {
      await discardBody(request.body)
      return json(415, { error: "content-type must be application/octet-stream" })
    }
    const body = await readBody(request, maxArtifactBytes)
    if (!body.ok) return body.response
    const measured = await sha256Hex(body.bytes)
    if (measured !== digest) return json(400, { error: `bytes digest to ${measured}` })
    const result = await contentStore.put(digest, body.bytes)
    return empty(result === "inserted" ? 201 : 200)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, HEAD, PUT")
}

const handleFindMissing = async (
  request: Request,
  contentStore: ContentStore
): Promise<Response> => {
  if (request.method !== "POST") {
    await discardBody(request.body)
    return methodNotAllowed("POST")
  }
  const parsed = await readJson(request, maxFindMissingBodyBytes)
  if (!parsed.ok) return parsed.response
  const digests = isRecord(parsed.value) ? parsed.value["digests"] : null
  if (!Array.isArray(digests)) return json(400, { error: "body must be {\"digests\":[...]}" })
  if (digests.length > maxFindMissingDigests) {
    return json(413, { error: `at most ${maxFindMissingDigests} digests may be probed at once` })
  }
  const unique = [...new Set(digests)]
  if (!unique.every((digest) => typeof digest === "string" && hexDigest.test(digest))) {
    return json(400, { error: "every digest must be 64 lowercase hex characters" })
  }
  const typedDigests = unique as string[]
  if (typedDigests.length === 0) return json(200, { missing: [] })
  const present = await contentStore.presentDigests(typedDigests)
  return json(200, {
    missing: typedDigests.filter((digest) => !present.has(digest))
  })
}

const diagnosticName = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/
const diagnosticCode = /^[A-Za-z0-9_.-]{1,32}$/

const diagnosticTag = (
  cause: object,
  field: "code" | "errno" | "name" | "syscall",
  shape: RegExp
): string | null => {
  let value: unknown
  try {
    value = Reflect.get(cause, field)
  } catch {
    return null
  }
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === "string" && shape.test(value) ? value : null
}

/**
 * Renders a failure as an allowlisted diagnostic that cannot carry a secret.
 *
 * @category utilities
 * @since 0.1.0
 */
export const describeFailure = (cause: unknown): string => {
  const kind = typeof cause
  if (typeof cause !== "object" || cause === null) {
    return `tsflows cache: request failed (kind=${cause === null ? "null" : kind})`
  }
  const tags = [
    ["name", diagnosticTag(cause, "name", diagnosticName)],
    ["code", diagnosticTag(cause, "code", diagnosticCode)],
    ["errno", diagnosticTag(cause, "errno", diagnosticCode)],
    ["syscall", diagnosticTag(cause, "syscall", diagnosticCode)]
  ].filter((tag): tag is [string, string] => tag[1] !== null)
  const attribution = tags.length === 0
    ? "unattributed"
    : tags.map((tag) => `${tag[0]}=${tag[1]}`).join(" ")
  return `tsflows cache: request failed (${attribution})`
}

/**
 * Creates the authenticated HTTP handler for the remote-cache protocol.
 *
 * The returned function owns its admission counters and readiness cache, so a
 * production caller must retain it for the lifetime of one Worker isolate.
 *
 * @category constructors
 * @since 0.1.0
 */
export const createHandler = (dependencies: ProtocolDependencies) => {
  const maxArtifactBytes = dependencies.maxArtifactBytes ?? maxArtifactBodyBytes
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > maxArtifactBodyBytes
  ) {
    throw new TypeError(`maxArtifactBytes must be an integer from 1 through ${maxArtifactBodyBytes}`)
  }
  if (typeof dependencies.tokenHash !== "string" || !hexDigest.test(dependencies.tokenHash)) {
    throw new TypeError("tokenHash must be a lowercase SHA-256 digest")
  }
  const health = dependencies.health ?? (async (): Promise<void> => undefined)
  if (typeof health !== "function") throw new TypeError("health must be a function")
  const expectedTokenHash = Uint8Array.from(
    dependencies.tokenHash.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16)
  )

  let activeCacheRequests = 0
  let activeArtifactTransfers = 0
  let healthInFlight: Promise<void> | null = null
  let lastHealthyAt = Number.NEGATIVE_INFINITY
  const ready = (): Promise<void> => {
    const now = performance.now()
    if (now >= lastHealthyAt && now - lastHealthyAt < healthCacheMilliseconds) {
      return Promise.resolve()
    }
    if (healthInFlight !== null) return healthInFlight
    let current: Promise<void>
    current = Promise.resolve()
      .then(health)
      .then(() => {
        lastHealthyAt = performance.now()
      })
      .finally(() => {
        if (healthInFlight === current) healthInFlight = null
      })
    healthInFlight = current
    return current
  }

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          await discardBody(request.body)
          return methodNotAllowed("GET, HEAD")
        }
        await discardBody(request.body)
        await ready()
        return request.method === "HEAD" ? empty(200) : json(200, { ok: true })
      }
      if (activeCacheRequests >= maxConcurrentCacheRequests) {
        await discardBody(request.body)
        return busy("too many simultaneous cache requests")
      }
      activeCacheRequests += 1
      try {
        if (!(await authorized(request, expectedTokenHash))) {
          await discardBody(request.body)
          return empty(401)
        }
        const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
        if (segments.length === 2 && segments[0] === "cas" && segments[1] === "findMissing") {
          return await handleFindMissing(request, dependencies.contentStore)
        }
        if (segments.length === 2 && segments[0] === "ac") {
          let keyDigest: string
          try {
            keyDigest = decodeURIComponent(segments[1] ?? "")
          } catch {
            await discardBody(request.body)
            return json(400, { error: "keyDigest must be valid URL encoding" })
          }
          return await handleActionCache(request, keyDigest, url, dependencies.actionCache)
        }
        if (segments.length === 2 && segments[0] === "cas") {
          let digest: string
          try {
            digest = decodeURIComponent(segments[1] ?? "")
          } catch {
            await discardBody(request.body)
            return json(400, { error: "digest must be valid URL encoding" })
          }
          if (request.method === "GET" || request.method === "PUT") {
            if (activeArtifactTransfers >= maxConcurrentArtifactTransfers) {
              await discardBody(request.body)
              return busy("too many simultaneous artifact transfers")
            }
            activeArtifactTransfers += 1
            try {
              return await handleArtifact(
                request,
                digest,
                dependencies.contentStore,
                maxArtifactBytes
              )
            } finally {
              activeArtifactTransfers -= 1
            }
          }
          return await handleArtifact(request, digest, dependencies.contentStore, maxArtifactBytes)
        }
        await discardBody(request.body)
        return empty(404)
      } finally {
        activeCacheRequests -= 1
      }
    } catch (cause) {
      console.error(describeFailure(cause))
      return json(503, { error: "the cache tier failed to answer" })
    }
  }
}
