import { describe, expect, it } from "bun:test"
import { computeSessionGroups } from "../telemetry/sessionGroups"
import type { RequestMetric } from "../telemetry/types"

let seq = 0

function metric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  seq++
  return {
    requestId: "req-" + seq,
    timestamp: 1_000_000 + seq * 1000,
    model: "sonnet",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 0,
    proxyOverheadMs: 0,
    ttfbMs: 100,
    upstreamDurationMs: 1000,
    totalDurationMs: 1000,
    contentBlocks: 1,
    textEvents: 1,
    error: null,
    ...overrides,
  }
}

/** A conversation that is getting somewhere: one more message every turn. */
function progressing(sdkSessionId: string, turns: number): RequestMetric[] {
  return Array.from({ length: turns }, (_, i) =>
    metric({ sdkSessionId, messageCount: i + 1 })
  )
}

/** A conversation that is not: the same state, sent again and again. */
function stuck(sdkSessionId: string, turns: number, upstreamDurationMs = 1000): RequestMetric[] {
  return Array.from({ length: turns }, () =>
    metric({ sdkSessionId, messageCount: 7, upstreamDurationMs })
  )
}

describe("computeSessionGroups — grouping", () => {
  it("puts each session's requests in its own group", () => {
    const report = computeSessionGroups([...progressing("aaa", 3), ...progressing("bbb", 2)])

    expect(report.sessions).toHaveLength(2)
    const byId = Object.fromEntries(report.sessions.map(s => [s.sessionId, s.requests]))
    expect(byId).toEqual({ aaa: 3, bbb: 2 })
  })

  it("counts requests with no session id separately instead of inventing a group", () => {
    const report = computeSessionGroups([
      ...progressing("aaa", 2),
      metric({ messageCount: 1 }),
      metric({ messageCount: 1 }),
    ])

    expect(report.sessions).toHaveLength(1)
    expect(report.ungroupedRequests).toBe(2)
  })

  it("spans the session from its oldest request to its newest", () => {
    // getRecent hands metrics back newest-first, so the group has to order them
    // itself rather than trusting the array it was given.
    const chronological = progressing("aaa", 3)
    const report = computeSessionGroups([...chronological].reverse())

    expect(report.sessions[0]!.firstTimestamp).toBe(chronological[0]!.timestamp)
    expect(report.sessions[0]!.lastTimestamp).toBe(chronological[2]!.timestamp)
  })

  it("reports the session's most-used model", () => {
    const report = computeSessionGroups([
      metric({ sdkSessionId: "aaa", messageCount: 1, requestModel: "opus" }),
      metric({ sdkSessionId: "aaa", messageCount: 2, requestModel: "haiku" }),
      metric({ sdkSessionId: "aaa", messageCount: 3, requestModel: "haiku" }),
    ])

    expect(report.sessions[0]!.model).toBe("haiku")
  })
})

describe("computeSessionGroups — which id identifies a conversation", () => {
  it("keeps one conversation together even though every turn gets a new SDK id", () => {
    // This is what real traffic looks like: the client resumes, and the Claude
    // SDK issues a fresh session id each turn. Grouping on the SDK id alone put
    // all 187 turns of one conversation into 187 buckets of one.
    const turns = [469, 471, 473, 475].map((messageCount, i) =>
      metric({ clientSessionId: "ses_opencode_1", sdkSessionId: `sdk-${i}`, messageCount, isResume: true })
    )

    const report = computeSessionGroups(turns)

    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]!.sessionId).toBe("ses_opencode_1")
    expect(report.sessions[0]!.requests).toBe(4)
    expect(report.sessions[0]!.repeats).toEqual([]) // it is progressing, not looping
  })

  it("sees a loop inside one conversation across distinct SDK ids", () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      metric({ clientSessionId: "ses_stuck", sdkSessionId: `sdk-${i}`, messageCount: 88 })
    )

    expect(computeSessionGroups(turns).sessions[0]!.repeats[0]!.occurrences).toBe(5)
  })

  it("keeps two different clients apart even if an SDK id were reused", () => {
    const report = computeSessionGroups([
      metric({ clientSessionId: "ses_a", sdkSessionId: "shared", messageCount: 4 }),
      metric({ clientSessionId: "ses_b", sdkSessionId: "shared", messageCount: 4 }),
    ])

    expect(report.sessions).toHaveLength(2)
    expect(report.sessions.every(g => g.repeats.length === 0)).toBe(true)
  })

  it("falls back to the SDK id for records written before client ids were tracked", () => {
    const report = computeSessionGroups([
      metric({ sdkSessionId: "legacy", messageCount: 1 }),
      metric({ sdkSessionId: "legacy", messageCount: 2 }),
    ])

    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]!.sessionId).toBe("legacy")
    expect(report.ungroupedRequests).toBe(0)
  })

  it("counts a request with neither id as ungrouped", () => {
    const report = computeSessionGroups([metric({ messageCount: 1 })])

    expect(report.sessions).toHaveLength(0)
    expect(report.ungroupedRequests).toBe(1)
  })
})

describe("computeSessionGroups — loop detection", () => {
  it("leaves a conversation that keeps growing alone", () => {
    const report = computeSessionGroups(progressing("aaa", 10))

    expect(report.sessions[0]!.repeats).toEqual([])
    expect(report.sessions[0]!.wastedUpstreamMs).toBe(0)
  })

  it("flags a session that resends the same state, with the repeat count", () => {
    const report = computeSessionGroups(stuck("aaa", 5))
    const group = report.sessions[0]!

    expect(group.repeats).toHaveLength(1)
    expect(group.repeats[0]!.occurrences).toBe(5)
    expect(group.repeats[0]!.messageCount).toBe(7)
  })

  it("charges only the repeats, not the first legitimate attempt", () => {
    // 5 identical calls at 1s each: the first was work, the other four were not.
    const group = computeSessionGroups(stuck("aaa", 5, 1000)).sessions[0]!

    expect(group.upstreamMs).toBe(5000)
    expect(group.repeats[0]!.repeatedUpstreamMs).toBe(4000)
    expect(group.wastedUpstreamMs).toBe(4000)
  })

  it("treats a different model or mode at the same length as a different shape", () => {
    const report = computeSessionGroups([
      metric({ sdkSessionId: "aaa", messageCount: 4, model: "sonnet", mode: "stream" }),
      metric({ sdkSessionId: "aaa", messageCount: 4, model: "opus", mode: "stream" }),
      metric({ sdkSessionId: "aaa", messageCount: 4, model: "sonnet", mode: "non-stream" }),
    ])

    expect(report.sessions[0]!.repeats).toEqual([])
  })

  it("ignores requests that never counted their messages", () => {
    // Early parse-error records carry no message array. Bucketing them together
    // would flag every session that logged two of them.
    const report = computeSessionGroups([
      metric({ sdkSessionId: "aaa", messageCount: undefined }),
      metric({ sdkSessionId: "aaa", messageCount: undefined }),
      metric({ sdkSessionId: "aaa", messageCount: undefined }),
    ])

    expect(report.sessions[0]!.repeats).toEqual([])
  })

  it("orders repeated shapes by how often they recurred", () => {
    const report = computeSessionGroups([
      ...Array.from({ length: 2 }, () => metric({ sdkSessionId: "aaa", messageCount: 3 })),
      ...Array.from({ length: 6 }, () => metric({ sdkSessionId: "aaa", messageCount: 9 })),
    ])

    expect(report.sessions[0]!.repeats.map(r => r.occurrences)).toEqual([6, 2])
  })

  it("forgives the first attempt chronologically, not the first one in the array", () => {
    // Same shape three times, getting slower. Only the earliest call was work.
    const chronological = [100, 500, 900].map(upstreamDurationMs =>
      metric({ sdkSessionId: "aaa", messageCount: 7, upstreamDurationMs })
    )
    const newestFirst = [...chronological].reverse()

    // Trusting the array order would forgive the 900ms call and report 600.
    for (const input of [chronological, newestFirst]) {
      const group = computeSessionGroups(input).sessions[0]!
      expect(group.repeats[0]!.occurrences).toBe(3)
      expect(group.repeats[0]!.repeatedUpstreamMs).toBe(1400)
      expect(group.wastedUpstreamMs).toBe(1400)
    }
  })
})

describe("computeSessionGroups — wasted time", () => {
  it("counts a failed request as waste even when its shape is unique", () => {
    const report = computeSessionGroups([
      metric({ sdkSessionId: "aaa", messageCount: 1 }),
      metric({ sdkSessionId: "aaa", messageCount: 2, error: "upstream_timeout", upstreamDurationMs: 30_000 }),
    ])

    expect(report.sessions[0]!.errorCount).toBe(1)
    expect(report.sessions[0]!.wastedUpstreamMs).toBe(30_000)
  })

  it("charges a failed repeat once, not twice", () => {
    const report = computeSessionGroups([
      metric({ sdkSessionId: "aaa", messageCount: 5, upstreamDurationMs: 100 }),
      metric({ sdkSessionId: "aaa", messageCount: 5, upstreamDurationMs: 100, error: "upstream_timeout" }),
    ])

    // The second call is both a repeat and a failure. It cost 100ms, once.
    expect(report.sessions[0]!.wastedUpstreamMs).toBe(100)
  })

  it("never reports more waste than the session spent upstream", () => {
    const group = computeSessionGroups([
      ...stuck("aaa", 3, 500),
      metric({ sdkSessionId: "aaa", messageCount: 99, error: "upstream_timeout", upstreamDurationMs: 500 }),
    ]).sessions[0]!

    expect(group.wastedUpstreamMs).toBeLessThanOrEqual(group.upstreamMs)
  })

  it("sorts the worst offender to the top and totals the window", () => {
    const report = computeSessionGroups([
      ...stuck("mild", 2, 100),
      ...stuck("severe", 4, 1000),
      ...progressing("clean", 3),
    ])

    expect(report.sessions[0]!.sessionId).toBe("severe")
    expect(report.sessions.at(-1)!.sessionId).toBe("clean")
    expect(report.totalWastedUpstreamMs).toBe(3000 + 100)
  })

  it("returns an empty report for an empty window", () => {
    expect(computeSessionGroups([])).toEqual({
      sessions: [],
      ungroupedRequests: 0,
      totalWastedUpstreamMs: 0,
    })
  })
})
