/**
 * Synchronous SHA-256 digests for canonical key material.
 *
 * @since 0.1.0
 */
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

const encoder = new TextEncoder()

/**
 * Returns the full lowercase SHA-256 digest of UTF-8 string or byte input.
 *
 * @since 0.1.0
 * @category hashing
 */
export const digest = (input: Uint8Array | string): string => {
  return bytesToHex(
    sha256(typeof input === "string" ? encoder.encode(input) : input)
  )
}
