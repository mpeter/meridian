import { describe, expect, it } from "bun:test"
import { dashboardHtml } from "../telemetry/dashboard"
import type { SessionGroup, SessionGroupsReport, TelemetrySummary } from "../telemetry/types"

/**
 * The dashboard's client script lives inside a template literal, so `tsc` never
 * looks at it — a typo there ships silently and only shows up as a blank panel
 * in the browser. These tests extract the script, run it against DOM stubs, and
 * assert on the HTML it writes.
 */
function renderDashboard(summary: TelemetrySummary, sessions?: unknown): string {
  // The page carries several inline scripts (profile bar, settings); take the
  // one that defines the summary renderer.
  const script = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]!)
    .find(body => body.includes("function render("))
  if (!script) throw new Error("dashboard has no inline <script> defining render()")

  const element = { addEventListener() {}, value: "", checked: false, innerHTML: "" }

  // Anything the script reaches for that we haven't modelled (location, timers,
  // browser APIs) resolves to a self-returning stub, so the test fails on the
  // rendered HTML rather than on an incidental global.
  const anything: unknown = new Proxy(function () {} as object, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : anything),
    apply: () => anything,
    has: () => true,
  })

  const globals: Record<string, unknown> = {
    document: {
      querySelector: () => element,
      querySelectorAll: () => [],
      getElementById: () => element,
    },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ json: async () => ({}) }),
  }

  const scope = new Proxy(globals, {
    // Capture our stubs and any browser-only identifier, but let real intrinsics
    // (Object, Math, JSON) resolve normally — shadowing those makes the renderer
    // silently produce wrong HTML instead of throwing.
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      // `with` consults Symbol.unscopables first; a truthy answer there makes it
      // skip every binding and fall through to the real globals.
      if (key === Symbol.unscopables) return undefined
      return key in target ? target[key as string] : anything
    },
  })

  const factory = new Function(
    "scope",
    `with (scope) { ${script}\n; return render }`
  ) as (
    scope: unknown
  ) => (s: TelemetrySummary, reqs: unknown[], logs: unknown[], sessions?: unknown) => void

  factory(scope)(summary, [], [], sessions)
  return element.innerHTML
}

const emptyPhase = { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 }

function makeSummary(overrides: Partial<TelemetrySummary> = {}): TelemetrySummary {
  return {
    windowMs: 3_600_000,
    totalRequests: 100,
    errorCount: 0,
    byError: {},
    envelopeViolationCount: 0,
    requestsPerMinute: 1.5,
    queueWait: emptyPhase,
    proxyOverhead: emptyPhase,
    ttfb: emptyPhase,
    upstreamDuration: emptyPhase,
    totalDuration: emptyPhase,
    byModel: {},
    byMode: {},
    tokenUsage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      avgCacheHitRate: 0,
      cacheMissOnResumeCount: 0,
    },
    costEstimate: { totalUsd: 0, byModel: {}, unpricedRequestCount: 0, byProfile: {} },
    ...overrides,
  }
}

describe("Dashboard error breakdown", () => {
  const withErrors = makeSummary({
    errorCount: 38,
    byError: { upstream_timeout: 30, invalid_request_error: 6, authentication_error: 2 },
  })

  it("names the dominant error type next to the error rate", () => {
    expect(renderDashboard(withErrors)).toContain("38.0% error rate — top: upstream_timeout")
  })

  it("renders a card per error type with its share of requests", () => {
    const html = renderDashboard(withErrors)
    expect(html).toContain("Error: upstream_timeout")
    expect(html).toContain("30.0% of requests")
    expect(html).toContain("Error: invalid_request_error")
    expect(html).toContain("Error: authentication_error")
  })

  it("orders the cards by count, descending", () => {
    const html = renderDashboard(withErrors)
    const positions = ["upstream_timeout", "invalid_request_error", "authentication_error"]
      .map(type => html.indexOf("Error: " + type))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect(positions[1]!).toBeGreaterThan(positions[0]!)
    expect(positions[2]!).toBeGreaterThan(positions[1]!)
  })

  it("omits the breakdown entirely on a clean window", () => {
    const html = renderDashboard(makeSummary())
    expect(html).not.toContain("Error: ")
    expect(html).toContain("error rate")
  })

  it("survives a summary with no byError field at all", () => {
    const legacy = makeSummary({ errorCount: 3 })
    delete (legacy as Partial<TelemetrySummary>).byError
    expect(() => renderDashboard(legacy)).not.toThrow()
  })
})

const now = 1_700_000_000_000

function makeGroup(overrides: Partial<SessionGroup> = {}): SessionGroup {
  return {
    sessionId: "01234567-89ab-cdef",
    model: "sonnet",
    requests: 3,
    errorCount: 0,
    firstTimestamp: now - 60_000,
    lastTimestamp: now,
    upstreamMs: 3000,
    wastedUpstreamMs: 0,
    repeats: [],
    ...overrides,
  }
}

function makeSessions(groups: SessionGroup[], overrides: Partial<SessionGroupsReport> = {}): SessionGroupsReport {
  return {
    sessions: groups,
    ungroupedRequests: 0,
    totalWastedUpstreamMs: groups.reduce((n, g) => n + g.wastedUpstreamMs, 0),
    ...overrides,
  }
}

describe("Dashboard sessions panel", () => {
  const looping = makeGroup({
    sessionId: "deadbeef-0000",
    requests: 9,
    upstreamMs: 10_000,
    wastedUpstreamMs: 9000,
    repeats: [{ model: "sonnet", messageCount: 7, occurrences: 4, repeatedUpstreamMs: 6000 }],
  })

  it("counts the grouped sessions in the tab badge", () => {
    const html = renderDashboard(makeSummary(), makeSessions([looping, makeGroup()]))
    expect(html).toContain('Sessions<span class="tab-badge">2</span>')
  })

  it("states the loop as a repeat count at a conversation length", () => {
    const html = renderDashboard(makeSummary(), makeSessions([looping]))
    expect(html).toContain("4\u00d7 at 7 msgs")
    expect(html).toContain("Looping Sessions")
  })

  it("shows how much of the session's upstream time the repeats cost", () => {
    const html = renderDashboard(makeSummary(), makeSessions([looping]))
    // 9000 of 10000ms wasted: past the 85% threshold, so red.
    expect(html).toContain("90%")
    expect(html).toContain("var(--red)")
  })

  it("summarises a healthy window calmly, with no warning colour", () => {
    const html = renderDashboard(makeSummary(), makeSessions([makeGroup(), makeGroup()]))
    expect(html).toContain("every session moved forward")
    expect(html).toContain("no repeated or failed calls")
    expect(html).not.toContain("loop-pill\"")
  })

  it("admits when some requests could not be grouped", () => {
    const many = renderDashboard(makeSummary(), makeSessions([makeGroup()], { ungroupedRequests: 4 }))
    expect(many).toContain("4 requests had no session id")

    const one = renderDashboard(makeSummary(), makeSessions([makeGroup()], { ungroupedRequests: 1 }))
    expect(one).toContain("1 request had no session id")
  })

  it("collapses a session with many distinct loops rather than filling the cell", () => {
    const repeats = [9, 6, 4, 2].map(occurrences => ({
      model: "sonnet",
      messageCount: occurrences,
      occurrences,
      repeatedUpstreamMs: 100,
    }))
    const html = renderDashboard(
      makeSummary(),
      makeSessions([makeGroup({ repeats, wastedUpstreamMs: 400 })])
    )
    expect(html).toContain("9\u00d7 at 9 msgs")
    expect(html).toContain("6\u00d7 at 6 msgs")
    expect(html).not.toContain("4\u00d7 at 4 msgs")
    expect(html).toContain("+2 more")
  })

  it("flags a session's failures next to its request count", () => {
    const html = renderDashboard(
      makeSummary(),
      makeSessions([makeGroup({ requests: 5, errorCount: 2, wastedUpstreamMs: 2000 })])
    )
    expect(html).toContain("2 failed")
  })

  it("explains what it means by repeated work", () => {
    const html = renderDashboard(makeSummary(), makeSessions([looping]))
    expect(html).toContain("upstream time that bought nothing")
  })

  it("escapes session ids and adapter names", () => {
    const html = renderDashboard(
      makeSummary(),
      makeSessions([makeGroup({ sessionId: '<img src=x>', adapter: '<script>x</script>' })])
    )
    expect(html).toContain("&lt;img src")
    expect(html).not.toContain("<img src=x>")
    expect(html).not.toContain("<script>x</script>")
  })

  it("says so plainly when nothing in the window carried a session id", () => {
    const html = renderDashboard(makeSummary(), makeSessions([]))
    expect(html).toContain("nothing to group")
  })

  it("still renders the rest of the page against a proxy that has no sessions route", () => {
    // An older build answers /telemetry/sessions with a 404 body. The dashboard
    // should lose one panel, not every panel.
    for (const payload of [undefined, {}, { error: "not_found" }]) {
      expect(() => renderDashboard(makeSummary(), payload)).not.toThrow()
      expect(renderDashboard(makeSummary(), payload)).toContain("error rate")
    }
  })
})
