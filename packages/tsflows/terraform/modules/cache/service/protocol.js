/*
 * The remote-cache HTTP protocol, with no storage and no listener in it.
 *
 *   GET    /ac/{keyDigest}            -> 200 stored entry JSON | 404
 *   PUT    /ac/{keyDigest}            -> 201 inserted | 200 already identical | 409 different
 *   DELETE /ac/{keyDigest}            -> 200 deleted | 404, fenced by ?recordedRunId&recordedEventSeq
 *   GET    /cas/{digest}              -> 200 octet-stream | 404
 *   PUT    /cas/{digest}              -> 201 stored | 200 already present
 *   HEAD   /cas/{digest}              -> 200 | 404
 *   POST   /cas/findMissing           -> 200 {"missing":[...]}
 *   GET    /healthz                   -> 200, unauthenticated
 *
 * This file is a translation of infra/worker/protocol.ts, which serves the
 * same protocol on Cloudflare. Both accept the two shapes the two real clients
 * publish: the `CacheEntry` envelope `RemoteCacheStore` sends, and the bare
 * `CachedResult` JSON the tsflows CLI sends. Every bound below is the bound
 * that file uses, so a client cannot tell the two backends apart.
 *
 * Storage arrives as `actionCache` and `contentStore`, so the protocol is
 * testable without a database and startup is somebody else's file.
 */

const hexDigest = /^[0-9a-f]{64}$/
const jsonContentType = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/
const decimalDigits = /^[0-9]+$/
const controlCharacters = /[\u0000-\u001f\u007f]/

/** The largest action-cache document the service accepts. */
export const maxActionCacheBodyBytes = 1024 * 1024

/** The largest `findMissing` request the service accepts. */
export const maxFindMissingBodyBytes = 256 * 1024

/** The most digests one `findMissing` request may probe. */
export const maxFindMissingDigests = 1000

/** The longest action-cache key the service stores. */
export const maxKeyDigestLength = 512

/** The most artifact references one publication records. */
export const maxReferencedDigests = 1000

/** The absolute per-artifact ceiling supported by this deployment. */
export const maxArtifactBodyBytes = 16 * 1024 * 1024

/** Structural limits applied to every JSON publication before it is stored. */
export const maxJsonDepth = 64
export const maxJsonMembers = 100_000
export const maxCanonicalJsonBytes = 2 * 1024 * 1024

/** Defends bounded bodies from streams made of unbounded empty/tiny chunks. */
export const maxBodyChunks = 16_384

/** Bounds all cache work and the large buffers held by CAS transfers. */
export const maxConcurrentCacheRequests = 64
export const maxConcurrentArtifactTransfers = 4

/** Successful readiness checks are coalesced for this monotonic interval. */
export const healthCacheMilliseconds = 1000

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
const textEncoder = new TextEncoder()

const utf8Bytes = (value) => textEncoder.encode(value).byteLength

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const empty = (status) => new Response(null, { status })

const busy = (message) =>
  new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" }
  })

/**
 * Refuses a method on a route that exists.
 *
 * RFC 9110 requires a 405 to name the methods the route does accept, and the
 * two real clients read it when they probe an endpoint they did not configure.
 */
const methodNotAllowed = (allowed) => new Response(null, { status: 405, headers: { allow: allowed } })

const mediaType = (request) => (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase()

const sha256 = (data) => new Bun.CryptoHasher("sha256").update(data).digest()

const sha256Hex = (data) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

/**
 * Cancels a body the handler decided not to read.
 *
 * A refusal taken from the headers alone has never acquired a reader, so the
 * stream itself is what has to be cancelled: returning without cancelling
 * leaves the sender uploading into a body nothing will ever drain. The
 * cancellation is best effort. A sender that already went away makes it fail,
 * and that failure must never replace the 400, 413, or 415 the client needs.
 */
const discardBody = async (body) => {
  if (body === null || body === undefined || typeof body.cancel !== "function") return
  try {
    await body.cancel()
  } catch {
    // The sender is gone, which is the outcome cancelling was asking for.
  }
}

/**
 * Reads at most `limit` bytes of a request body, refusing anything longer
 * before it is allocated.
 *
 * `Content-Length` is checked for syntax and for size, and is then not trusted:
 * a chunked upload declares nothing at all, and a declared length is a claim
 * the sender controls. The stream is what the bound is enforced against, so
 * the refusal fires at most one chunk past the limit.
 *
 * Every exit releases the reader lock exactly once, and every exit that leaves
 * bytes unread cancels the stream first. That holds for the header refusals,
 * for the overflow refusal, for normal completion, and for a failed read, whose
 * error is rethrown unchanged: a cancel or a release that fails on the way out
 * is swallowed, because it is a consequence of the failure and never the
 * diagnosis of it.
 */
const readBody = async (request, limit) => {
  const contentLength = request.headers.get("content-length")
  let declaredLength = null
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
  const release = () => {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // A reader that cannot be released is already unusable; the answer stands.
    }
  }
  const abandon = async () => {
    try {
      await reader.cancel()
    } catch {
      // Same position as discardBody: cancelling is best effort.
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

/** Reads a bounded body and requires it to be a UTF-8 JSON document. */
const readJson = async (request, limit) => {
  if (!jsonContentType.test(mediaType(request))) {
    await discardBody(request.body)
    return { ok: false, response: json(415, { error: "content-type must be application/json" }) }
  }
  const body = await readBody(request, limit)
  if (!body.ok) return body
  let text
  try {
    text = textDecoder.decode(body.bytes)
  } catch {
    return { ok: false, response: json(400, { error: "body must be UTF-8 JSON" }) }
  }
  try {
    return { ok: true, text, value: JSON.parse(text) }
  } catch {
    return { ok: false, response: json(400, { error: "body must be valid JSON" }) }
  }
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Renders a JSON value with object members in sorted order.
 *
 * Publication conflict is decided on this text, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same result and a re-publication that only reordered
 * its members is not escalated to the client as a hermeticity violation.
 *
 * @category utilities
 */
const renderCanonicalJson = (value) => {
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
 * Validation precedes rendering, so cycles, accessors, sparse arrays, exotic
 * prototypes, negative zero, and adversarial nesting never reach the recursive
 * renderer. JSON parsed from a request naturally satisfies the inertness
 * checks; the checks also keep this exported utility safe for direct callers.
 *
 * @category utilities
 */
export const canonicalJson = (value) => {
  const ancestors = new Set()
  let members = 0
  const validate = (current, depth) => {
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
      if (prototype !== Object.prototype && prototype !== null) throw new Error("object is not a JSON object")
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
  if (utf8Bytes(rendered) > maxCanonicalJsonBytes) throw new Error("canonical JSON exceeds its byte bound")
  return rendered
}

/**
 * Refuses an action-cache key that cannot be stored or cannot have come from a
 * client.
 *
 * A step key is a `@smthrs/keys` key and the CLI's key is a planner content
 * key, so the shape is deliberately wide: any non-empty, bounded, control-free
 * string, including one whose percent-encoding decoded to slashes. The bound
 * matches the column check in migrations/0001_initial.sql.
 */
const invalidKeyDigest = (keyDigest) => {
  if (keyDigest.length === 0) return "empty keyDigest"
  if (utf8Bytes(keyDigest) > maxKeyDigestLength) {
    return `keyDigest must be at most ${maxKeyDigestLength} UTF-8 bytes`
  }
  if (controlCharacters.test(keyDigest)) return "keyDigest must not contain control characters"
  return null
}

/** Extracts only artifacts the engine's declared-output boundary references. */
const referencedDigests = (record) => {
  const outputs = record?.meta?.boundary?.declaredOutputs?.outputs
  if (outputs === undefined) return []
  if (!Array.isArray(outputs)) throw new Error("declared outputs must be an array")
  const references = new Set()
  for (const output of outputs) {
    if (!isRecord(output)) throw new Error("declared output must be an object")
    if (!Object.hasOwn(output, "digest") || output.digest === null || Object.hasOwn(output, "content")) continue
    if (typeof output.digest !== "string" || !hexDigest.test(output.digest)) {
      throw new Error("declared output digest is invalid")
    }
    references.add(output.digest)
    if (references.size > maxReferencedDigests) throw new Error("publication references too many artifacts")
  }
  return [...references]
}

/**
 * Validates one action-cache publication in either shape a real client sends.
 *
 * `RemoteCacheStore` publishes a `CacheEntry` envelope with `keyDigest`,
 * `result`, `meta`, and journal provenance. The tsflows CLI publishes that same
 * envelope, and older compatible clients publish the bare `CachedResult`
 * document. The stored bytes are the client's own, so a lookup returns exactly
 * what was published; only the conflict discriminator and the provenance
 * columns are derived.
 */
const readPublication = async (request, keyDigest) => {
  const parsed = await readJson(request, maxActionCacheBodyBytes)
  if (!parsed.ok) return parsed
  const record = isRecord(parsed.value) ? parsed.value : null
  if (record !== null && Object.hasOwn(record, "keyDigest") && record.keyDigest !== keyDigest) {
    return {
      ok: false,
      response: json(400, { error: "keyDigest must match the request path when supplied" })
    }
  }

  // A bare CachedResult may itself have a member named `result`. Require the
  // path-matching cache key as well before interpreting envelope metadata.
  const enveloped = record !== null && Object.hasOwn(record, "keyDigest") && Object.hasOwn(record, "result")
  let resultJson
  let digests
  try {
    // Validate the whole envelope, not just the conflict discriminator. This
    // prevents deeply nested or over-wide metadata from reaching storage.
    canonicalJson(parsed.value)
    resultJson = canonicalJson(enveloped ? record.result : parsed.value)
    digests = enveloped ? referencedDigests(record) : []
  } catch {
    return { ok: false, response: json(400, { error: "body contains invalid or unsupported cache metadata" }) }
  }

  const metadata = enveloped ? record : null
  const hasCreatedAtMs = metadata !== null && Object.hasOwn(metadata, "createdAtMs")
  const createdAtMs = hasCreatedAtMs ? metadata.createdAtMs : null
  if (hasCreatedAtMs && (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)) {
    return { ok: false, response: json(400, { error: "createdAtMs must be a non-negative safe integer" }) }
  }

  const hasRecordedRunId = metadata !== null && Object.hasOwn(metadata, "recordedRunId")
  const hasRecordedEventSeq = metadata !== null && Object.hasOwn(metadata, "recordedEventSeq")
  if (hasRecordedRunId !== hasRecordedEventSeq) {
    return {
      ok: false,
      response: json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
  }
  const recordedRunId = hasRecordedRunId ? metadata.recordedRunId : null
  const recordedEventSeq = hasRecordedEventSeq ? metadata.recordedEventSeq : null
  if (
    hasRecordedRunId && (
      typeof recordedRunId !== "string" ||
      recordedRunId.length === 0 ||
      utf8Bytes(recordedRunId) > maxKeyDigestLength ||
      controlCharacters.test(recordedRunId) ||
      !Number.isSafeInteger(recordedEventSeq) ||
      recordedEventSeq < 0
    )
  ) {
    return { ok: false, response: json(400, { error: "publication provenance is invalid" }) }
  }
  return {
    ok: true,
    publication: {
      body: parsed.text,
      resultJson,
      createdAtMs,
      recordedRunId,
      recordedEventSeq,
      digests
    }
  }
}

/**
 * Splits a credential off an `Authorization` header.
 *
 * RFC 9110 makes the scheme name case-insensitive and allows more than one
 * space before the credential, so a conforming client that sends `bearer` is
 * authenticated rather than refused. The match is anchored and its only
 * quantifier is over a single literal, so a hostile header cannot make it
 * backtrack.
 */
const bearerScheme = /^Bearer +/i

/**
 * Compares the presented bearer token against the configured one in time that
 * does not depend on how much of it matched.
 *
 * Both sides are SHA-256 digests, so the comparison is over two fixed 32-byte
 * values whatever the token lengths are. A null hash is the documented
 * development mode: no token is configured, the check is disabled, and the
 * service must only be bound to loopback.
 */
const authorized = (request, tokenHash) => {
  if (tokenHash === null) return true
  const authorization = request.headers.get("authorization") ?? ""
  const scheme = bearerScheme.exec(authorization)
  const bearer = scheme !== null
  const supplied = sha256(textEncoder.encode(bearer ? authorization.slice(scheme[0].length) : ""))
  const wellFormed = hexDigest.test(tokenHash)
  const expected = wellFormed
    ? Uint8Array.from(tokenHash.match(/.{2}/g), (pair) => Number.parseInt(pair, 16))
    : new Uint8Array(32)
  let difference = 0
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= supplied[index] ^ expected[index]
  }
  return wellFormed && bearer && difference === 0
}

const handleActionCache = async (request, keyDigest, url, actionCache) => {
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
    const outcome = await actionCache.put(keyDigest, publication.publication)
    if (outcome === "inserted") return json(201, { keyDigest })
    return empty(outcome === "identical" ? 200 : 409)
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
      return json(400, { error: "recordedRunId and recordedEventSeq must be supplied together" })
    }
    let fence = null
    if (runId !== null && eventSeq !== null) {
      // A malformed fence must not become an unfenced delete, and must not
      // reach Postgres as NaN either. Refusing it is the only safe answer.
      if (runId.length === 0 || utf8Bytes(runId) > maxKeyDigestLength || controlCharacters.test(runId)) {
        return json(400, { error: "recordedRunId must be a non-empty bounded string" })
      }
      const seq = Number(eventSeq)
      if (!decimalDigits.test(eventSeq) || !Number.isSafeInteger(seq)) {
        return json(400, { error: "recordedEventSeq must be a non-negative safe integer" })
      }
      fence = { runId, eventSeq: seq }
    }
    return empty(await actionCache.delete(keyDigest, fence) ? 200 : 404)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, PUT, DELETE")
}

const handleArtifact = async (request, digest, contentStore, maxArtifactBytes) => {
  if (!hexDigest.test(digest)) {
    await discardBody(request.body)
    return json(400, { error: "digest must be 64 lowercase hex characters" })
  }
  if (request.method === "HEAD") {
    await discardBody(request.body)
    return empty(await contentStore.has(digest) ? 200 : 404)
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
    // The server measures too. A client is the least trusted writer there is,
    // and an address that does not match its bytes would poison every reader.
    const measured = sha256Hex(body.bytes)
    if (measured !== digest) return json(400, { error: `bytes digest to ${measured}` })
    return empty(await contentStore.put(digest, body.bytes) === "inserted" ? 201 : 200)
  }
  await discardBody(request.body)
  return methodNotAllowed("GET, HEAD, PUT")
}

const handleFindMissing = async (request, contentStore) => {
  if (request.method !== "POST") {
    await discardBody(request.body)
    return methodNotAllowed("POST")
  }
  const parsed = await readJson(request, maxFindMissingBodyBytes)
  if (!parsed.ok) return parsed.response
  const digests = isRecord(parsed.value) ? parsed.value.digests : null
  if (!Array.isArray(digests)) return json(400, { error: "body must be {\"digests\":[...]}" })
  if (digests.length > maxFindMissingDigests) {
    return json(413, { error: `at most ${maxFindMissingDigests} digests may be probed at once` })
  }
  // Deduplication keeps first-occurrence order, so the answer is in request
  // order the way Bazel's MissingDigestsFinder expects.
  const unique = [...new Set(digests)]
  if (!unique.every((digest) => typeof digest === "string" && hexDigest.test(digest))) {
    return json(400, { error: "every digest must be 64 lowercase hex characters" })
  }
  if (unique.length === 0) return json(200, { missing: [] })
  const present = await contentStore.presentDigests(unique)
  return json(200, { missing: unique.filter((digest) => !present.has(digest)) })
}

/** The shapes a diagnostic tag may have. Anything else is dropped, not truncated. */
const diagnosticName = /^[A-Za-z][A-Za-z0-9_$]{0,39}$/
const diagnosticCode = /^[A-Za-z0-9_.-]{1,32}$/

/**
 * Reads one allowlisted field off a failure, or nothing.
 *
 * The read is guarded because a hostile or half-constructed error can define
 * the field as a throwing getter, and a diagnostic that throws would replace
 * the 503 the client has to receive.
 */
const diagnosticTag = (cause, field, shape) => {
  let value
  try {
    value = cause[field]
  } catch {
    return null
  }
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null
  return typeof value === "string" && shape.test(value) ? value : null
}

/**
 * Renders a failure as a diagnostic that cannot carry a secret.
 *
 * Bun, its Postgres client, and the socket layer all attach request-derived
 * material to their errors: the failing statement, its bound parameters, the
 * connection string, and whatever header or body produced the call. Logging
 * the error object, its message, or its stack publishes that material to
 * whatever collects container output, so none of it is read here.
 *
 * What is read is a fixed four-field allowlist, each value admitted only if it
 * already has the shape of an identifier or a SQLSTATE. `message`, `stack`,
 * `query`, `parameters`, `headers`, `cause`, and every other field are never
 * touched, so no amount of nesting exposes them. An error that carries none of
 * the four is reported as unattributed rather than described.
 *
 * @category utilities
 */
export const describeFailure = (cause) => {
  const kind = typeof cause
  if (kind !== "object" || cause === null) {
    return `tsflows cache: request failed (kind=${cause === null ? "null" : kind})`
  }
  const tags = [
    ["name", diagnosticTag(cause, "name", diagnosticName)],
    ["code", diagnosticTag(cause, "code", diagnosticCode)],
    ["errno", diagnosticTag(cause, "errno", diagnosticCode)],
    ["syscall", diagnosticTag(cause, "syscall", diagnosticCode)]
  ].filter((tag) => tag[1] !== null)
  const attribution = tags.length === 0 ? "unattributed" : tags.map((tag) => `${tag[0]}=${tag[1]}`).join(" ")
  return `tsflows cache: request failed (${attribution})`
}

/**
 * Creates the request handler for the remote-cache protocol.
 *
 * `tokenHash` is the lowercase hex SHA-256 of the bearer token, or null for the
 * documented unauthenticated development mode. `maxArtifactBytes` bounds one
 * `PUT /cas` body.
 *
 * @category constructors
 */
export const createHandler = (
  { actionCache, contentStore, health = async () => true, tokenHash, maxArtifactBytes }
) => {
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > maxArtifactBodyBytes) {
    throw new TypeError(`maxArtifactBytes must be an integer from 1 through ${maxArtifactBodyBytes}`)
  }
  if (tokenHash !== null && (typeof tokenHash !== "string" || !hexDigest.test(tokenHash))) {
    throw new TypeError("tokenHash must be a lowercase SHA-256 digest or null")
  }
  if (typeof health !== "function") throw new TypeError("health must be a function")
  let activeCacheRequests = 0
  let activeArtifactTransfers = 0
  let healthInFlight = null
  let lastHealthyAt = Number.NEGATIVE_INFINITY
  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now()
  const ready = () => {
    const now = monotonicNow()
    if (now >= lastHealthyAt && now - lastHealthyAt < healthCacheMilliseconds) return Promise.resolve()
    if (healthInFlight !== null) return healthInFlight
    let current
    current = Promise.resolve()
      .then(() => health())
      .then(() => {
        lastHealthyAt = monotonicNow()
      })
      .finally(() => {
        if (healthInFlight === current) healthInFlight = null
      })
    healthInFlight = current
    return current
  }

  return async (request) => {
    try {
      const url = new URL(request.url)
      // The container healthcheck runs before any token is in play, and a
      // readiness answer reveals no cache state.
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          await discardBody(request.body)
          return methodNotAllowed("GET, HEAD")
        }
        await discardBody(request.body)
        await ready()
        return request.method === "HEAD" ? empty(200) : json(200, { ok: true })
      }
      if (!authorized(request, tokenHash)) {
        await discardBody(request.body)
        return empty(401)
      }
      if (activeCacheRequests >= maxConcurrentCacheRequests) {
        await discardBody(request.body)
        return busy("too many simultaneous cache requests")
      }
      activeCacheRequests += 1
      try {
        const segments = url.pathname.split("/").filter((segment) => segment.length > 0)
        if (segments.length === 2 && segments[0] === "cas" && segments[1] === "findMissing") {
          return await handleFindMissing(request, contentStore)
        }
        if (segments.length === 2 && segments[0] === "ac") {
          let keyDigest
          try {
            keyDigest = decodeURIComponent(segments[1])
          } catch {
            await discardBody(request.body)
            return json(400, { error: "keyDigest must be valid URL encoding" })
          }
          return await handleActionCache(request, keyDigest, url, actionCache)
        }
        if (segments.length === 2 && segments[0] === "cas") {
          let digest
          try {
            digest = decodeURIComponent(segments[1])
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
              return await handleArtifact(request, digest, contentStore, maxArtifactBytes)
            } finally {
              activeArtifactTransfers -= 1
            }
          }
          return await handleArtifact(request, digest, contentStore, maxArtifactBytes)
        }
        await discardBody(request.body)
        return empty(404)
      } finally {
        activeCacheRequests -= 1
      }
    } catch (cause) {
      // A failure here is the tier refusing, which the client treats as
      // retryable and never as a miss. Saying so with a 503 keeps that
      // distinction intact. Only the allowlisted attribution is logged: the cause
      // itself may embed the connection string, the statement, its parameters, or
      // the request that produced it, and the request carries the bearer token.
      console.error(describeFailure(cause))
      return json(503, { error: "the cache tier failed to answer" })
    }
  }
}
