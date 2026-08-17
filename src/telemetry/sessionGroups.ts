/**
 * Session-level rollup of request metrics.
 *
 * The request table answers "was that request slow". It cannot answer "is this
 * agent going in circles", because a loop looks like a column of individually
 * healthy rows — each one fast, successful, and indistinguishable from the last.
 * Grouping by conversation and counting repeated request shapes makes the loop
 * the first thing on the page instead of something you have to notice.
 *
 * Pure: takes metrics, returns a report. No store access, no I/O.
 */

import type { RequestMetric, SessionGroup, SessionGroupsReport, SessionShapeRepeat } from "./types"

/**
 * The conversation a request belongs to.
 *
 * clientSessionId first, and the distinction is the whole feature: a resumed
 * turn is issued a *new* Claude SDK session id every time, so sdkSessionId
 * identifies one upstream call rather than the conversation containing it.
 * Grouping on it alone yields one bucket per request and no loop ever forms.
 * It stays as a fallback for records written before the client id was tracked.
 */
function sessionKey(m: RequestMetric): string | undefined {
  return m.clientSessionId || m.sdkSessionId
}

/**
 * What a request "looked like" upstream. Two requests with the same shape in
 * one conversation mean the agent sent a state it had already sent.
 *
 * Null when messageCount is absent — early parse-error records never counted a
 * message array. Those are left out of repeat detection rather than bucketed
 * under a placeholder, which would flag every session unlucky enough to log
 * two of them.
 */
function shapeKey(m: RequestMetric): string | null {
  if (m.messageCount == null) return null
  return `${m.requestModel || m.model} ${m.messageCount} ${m.mode}`
}

function summarizeSession(sessionId: string, bucket: RequestMetric[]): SessionGroup {
  // getRecent hands back newest-first; "the first occurrence of a shape" only
  // means anything in the order the requests actually happened.
  const ordered = [...bucket].sort((a, b) => a.timestamp - b.timestamp)
  const modelCounts = new Map<string, number>()
  const shapes = new Map<string, SessionShapeRepeat>()
  let errorCount = 0
  let upstreamMs = 0
  let wastedUpstreamMs = 0

  for (const m of ordered) {
    const model = m.requestModel || m.model
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
    upstreamMs += m.upstreamDurationMs
    if (m.error !== null) errorCount++

    const key = shapeKey(m)
    let isRepeat = false
    if (key !== null) {
      const seen = shapes.get(key)
      if (seen) {
        seen.occurrences++
        seen.repeatedUpstreamMs += m.upstreamDurationMs
        isRepeat = true
      } else {
        shapes.set(key, { model, messageCount: m.messageCount ?? 0, occurrences: 1, repeatedUpstreamMs: 0 })
      }
    }

    // Union, not sum: a failed retry of an already-seen shape is one wasted
    // call, not two.
    if (isRepeat || m.error !== null) wastedUpstreamMs += m.upstreamDurationMs
  }

  const repeats = [...shapes.values()]
    .filter(s => s.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences || b.repeatedUpstreamMs - a.repeatedUpstreamMs)
  const dominantModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown"

  return {
    sessionId,
    adapter: ordered.find(m => m.adapter)?.adapter,
    requestSource: ordered.find(m => m.requestSource)?.requestSource,
    model: dominantModel,
    requests: ordered.length,
    errorCount,
    firstTimestamp: ordered[0]!.timestamp,
    lastTimestamp: ordered[ordered.length - 1]!.timestamp,
    upstreamMs,
    wastedUpstreamMs,
    repeats,
  }
}

export function computeSessionGroups(metrics: RequestMetric[]): SessionGroupsReport {
  const bySession = new Map<string, RequestMetric[]>()
  let ungroupedRequests = 0

  for (const m of metrics) {
    const key = sessionKey(m)
    if (!key) {
      ungroupedRequests++
      continue
    }
    const bucket = bySession.get(key)
    if (bucket) bucket.push(m)
    else bySession.set(key, [m])
  }

  const sessions: SessionGroup[] = []
  for (const [sessionId, bucket] of bySession) sessions.push(summarizeSession(sessionId, bucket))
  sessions.sort((a, b) => b.wastedUpstreamMs - a.wastedUpstreamMs || b.requests - a.requests)

  return {
    sessions,
    ungroupedRequests,
    totalWastedUpstreamMs: sessions.reduce((sum, s) => sum + s.wastedUpstreamMs, 0),
  }
}
