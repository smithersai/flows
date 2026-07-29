import { runHostContract } from "@flows/host/test/contract"
import * as CloudflareFileSystem from "../src/CloudflareFileSystem.ts"
import * as CloudflareHost from "../src/CloudflareHost.ts"

const values = new Map<string, Uint8Array>()

const store: CloudflareFileSystem.ObjectStore = {
  get: async (key) => values.get(key),
  put: async (key, value) => {
    values.set(key, new Uint8Array(value))
  },
  delete: async (key) => {
    values.delete(key)
  },
  list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix))
}

runHostContract("CloudflareHost", CloudflareHost.layer(store), {
  fileSystem: { expected: "success", scratchPath: "cloudflare-host-contract" },
  path: { expected: "success" },
  shell: { expected: "failure", code: "shell_unavailable" },
  pty: { expected: "failure", code: "unsupported" },
  jj: { expected: "failure", code: "not_installed" },
  httpTransport: { expected: "failure", code: "TransportError" }
})
