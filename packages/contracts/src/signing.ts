/**
 * Canonical request format for runner HMAC signatures (protocol v1).
 *
 *   signature = hex(HMAC-SHA256(RUNNER_SHARED_SECRET, canonical))
 *   canonical = "v1\n" + METHOD + "\n" + PATH_AND_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(body))
 *
 * TIMESTAMP is Unix seconds; the runner rejects requests more than 60s from
 * its clock and remembers nonces for the acceptance window to stop replays.
 * This module is pure so it can be shared with browser code; hashing happens
 * in the API (node:crypto) and in the runner (crypto/hmac).
 */
export const SIGNATURE_MAX_SKEW_SECONDS = 60;

export function canonicalRequest(
  method: string,
  pathAndQuery: string,
  timestamp: string,
  nonce: string,
  bodySha256Hex: string,
): string {
  return ['v1', method.toUpperCase(), pathAndQuery, timestamp, nonce, bodySha256Hex].join('\n');
}
