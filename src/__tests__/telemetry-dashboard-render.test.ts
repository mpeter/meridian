import { describe, expect, it } from "bun:test"
import { dashboardHtml } from "../telemetry/dashboard"
import type { TelemetrySummary } from "../telemetry/types"

/**
 * The dashboard's client script lives inside a template literal, so `tsc` never
 * looks at it — a typo there ships silently and only shows up as a blank panel
 * in the browser. These tests extract the script, run it against DOM stubs, and
 * assert on the HTML it writes.
 */
function renderDashboard(summary: TelemetrySummary): string {
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
  ) as (scope: unknown) => (s: TelemetrySummary, reqs: unknown[], logs: unknown[]) => void

  factory(scope)(summary, [], [])
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
