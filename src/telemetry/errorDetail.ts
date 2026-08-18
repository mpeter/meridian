/**
 * Durable detail for a failed request.
 *
 * `RequestMetric.error` carries the classifier's verdict — `invalid_request_error`,
 * `upstream_timeout` — and nothing else. That vocabulary is deliberately small:
 * it is what the error-rate breakdown aggregates on, and free-form messages
 * would blow up its cardinality. But it is also the whole record, so a failure
 * that repeats says only *that* it repeated.
 *
 * On 2026-08-17 a session sent the same 223-message turn three times against a
 * `invalid_request_error` that was never going to clear. The Sessions tab found
 * the loop; nothing on the record said why it failed. The raw text existed — it
 * reaches `claudeLog("proxy.error", ...)` at the outer catch — but a log line is
 * only useful if the log is reachable, and under an in-process host it goes
 * wherever the host's stderr goes. The record is the thing that is always there.
 *
 * So: keep the classified type for aggregation, and carry the upstream text
 * alongside it for the one question aggregation cannot answer. Bounded, because
 * an upstream message is not a size the proxy controls.
 */

/** Longest detail retained. Upstream failures state the problem in their first
 *  clause — "prompt is too long: 234567 tokens > 200000 maximum" is 47 — so this
 *  keeps the diagnosis and drops repeated stack frames and echoed payloads. */
export const MAX_ERROR_DETAIL_LENGTH = 300

/**
 * Normalize an upstream error into a single bounded line, or `undefined` when
 * there is nothing worth storing.
 *
 * Whitespace is collapsed because multi-line text renders as one run in a table
 * cell and a tooltip anyway, and the newlines only cost storage.
 */
export function summarizeErrorDetail(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined

  const text = (typeof raw === "string" ? raw : String(raw)).replace(/\s+/g, " ").trim()
  if (text.length === 0) return undefined
  if (text.length <= MAX_ERROR_DETAIL_LENGTH) return text

  return text.slice(0, MAX_ERROR_DETAIL_LENGTH - 1) + "\u2026"
}
