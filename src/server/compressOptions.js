// @fastify/compress options. Responses keep every encoding (encoding is not the risky side), but request
// bodies are decompressed only from gzip and deflate: no client of this server sends a compressed body, and
// keeping Brotli off unauthenticated input means a Brotli decoder flaw (CVE-2026-111497) cannot be reached
// that way. A Brotli-encoded request gets 415 before any decoding.
export function compressOptions() {
  return { requestEncodings: ['gzip', 'deflate'] }
}
