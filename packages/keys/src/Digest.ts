/**
 * Synchronous SHA-256 digests for canonical key material.
 *
 * @since 0.1.0
 */
import { sha256 } from "./internal/sha256.ts"

const encoder = new TextEncoder()

/**
 * Returns the full lowercase SHA-256 digest of UTF-8 string or byte input.
 *
 * @since 0.1.0
 * @category hashing
 */
export const digest = (input: Uint8Array | string): string => {
  const bytes = typeof input === "string" ? encoder.encode(input) : input
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
