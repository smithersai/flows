import { runHostContract } from "@flows/host/test/contract"
import type * as VercelFileSystem from "../src/VercelFileSystem.ts"
import * as VercelHost from "../src/VercelHost.ts"

const values = new Map<string, Uint8Array>()

const storage: VercelFileSystem.Storage = {
  kv: {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, new Uint8Array(value))
    },
    del: async (key) => {
      values.delete(key)
    },
    scan: async (prefix = "") => [...values.keys()].filter((key) => key.startsWith(prefix))
  }
}

runHostContract("VercelHost", VercelHost.layer({ storage }), {
  fileSystem: { expected: "success", scratchPath: "/vercel-host-contract" },
  path: { expected: "success" },
  shell: { expected: "failure", code: "shell_unavailable" },
  pty: { expected: "failure", code: "unsupported" },
  jj: { expected: "failure", code: "not_installed" },
  httpTransport: { expected: "failure", code: "TransportError" }
})
