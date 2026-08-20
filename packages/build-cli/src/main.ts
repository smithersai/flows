#!/usr/bin/env node

/**
 * Runs the smthrs command-line process with cancellation-aware signal wiring.
 *
 * @since 0.1.0
 */

import { makeCli } from "./Cli.ts"

const cacheUrl = process.env["SMITHERS_CACHE_URL"]
const cacheToken = process.env["SMITHERS_CACHE_TOKEN"]
delete process.env["SMITHERS_CACHE_URL"]
delete process.env["SMITHERS_CACHE_TOKEN"]

const controller = new AbortController()
let interrupted = false
const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
  interrupted = true
  process.exitCode = 1
  controller.abort(new Error(`smithers build interrupted by ${signal}`))
}
const onSigint = (): void => interrupt("SIGINT")
const onSigterm = (): void => interrupt("SIGTERM")

process.once("SIGINT", onSigint)
process.once("SIGTERM", onSigterm)
try {
  await makeCli({ cacheUrl, cacheToken, signal: controller.signal }).serve(process.argv.slice(2), {
    exit: (code) => {
      process.exitCode = code
    }
  })
} finally {
  process.removeListener("SIGINT", onSigint)
  process.removeListener("SIGTERM", onSigterm)
  if (interrupted) process.exitCode = 1
}
