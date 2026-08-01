/**
 * `NodeHost` again, but taking every default the contract offers: the default
 * scratch path, the default shell option set, and — unlike the other bundles —
 * an HTTP transport that is expected to *succeed*, against a loopback server
 * started for the run. A transport that only ever refuses a connection never
 * proves the response actually comes back.
 */
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect } from "vitest"
import * as NodeHost from "../../src/node/NodeHost.ts"
import { runHostContract } from "./HostContract.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain", "x-host-contract": `echo:${request.url}` })
  response.end("host-contract")
})
server.unref()
const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
})

runHostContract("NodeHost defaults", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  shell: { expected: "success" },
  pty: { expected: "success" },
  jj: jjAvailable
    ? { expected: "success" }
    : { expected: "failure", code: "not_installed" },
  httpTransport: {
    expected: "success",
    request: HttpClientRequest.get(`http://127.0.0.1:${port}/probe`),
    assertResponse: (response) => {
      expect(response.status).toBe(200)
      // Proves the loopback server answered this exact request, not a cache or
      // a redirect: the header echoes the path the transport asked for.
      expect(response.headers["x-host-contract"]).toBe("echo:/probe")
    }
  }
})
