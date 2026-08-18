import { describe, expect, it, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summarizeErrorDetail, MAX_ERROR_DETAIL_LENGTH } from "../telemetry/errorDetail"
import { createSqliteStores } from "../telemetry/sqlite"
import { computeSummary } from "../telemetry/percentiles"
import { dashboardHtml } from "../telemetry/dashboard"
import type { RequestMetric, TelemetrySummary } from "../telemetry/types"

describe("summarizeErrorDetail", () => {
  it("returns undefined when there is nothing to record", () => {
    expect(summarizeErrorDetail(null)).toBeUndefined()
    expect(summarizeErrorDetail(undefined)).toBeUndefined()
    expect(summarizeErrorDetail("")).toBeUndefined()
    expect(summarizeErrorDetail("   \n\t  ")).toBeUndefined()
  })

  it("keeps a short upstream message verbatim", () => {
    const msg = "prompt is too long: 234567 tokens > 200000 maximum"
    expect(summarizeErrorDetail(msg)).toBe(msg)
  })

  it("collapses newlines and runs of whitespace into single spaces", () => {
    expect(summarizeErrorDetail("first line\n\n  second\tline  ")).toBe("first line second line")
  })

  it("truncates past the bound and marks the cut, landing exactly on the bound", () => {
    const long = "x".repeat(MAX_ERROR_DETAIL_LENGTH + 500)
    const out = summarizeErrorDetail(long)!

    expect(out.length).toBe(MAX_ERROR_DETAIL_LENGTH)
    expect(out.endsWith("…")).toBe(true)
    // The diagnosis lives in the opening clause, so the head must survive intact.
    expect(out.startsWith("x".repeat(20))).toBe(true)
  })

  it("does not truncate a message sitting exactly on the bound", () => {
    const exact = "y".repeat(MAX_ERROR_DETAIL_LENGTH)
    const out = summarizeErrorDetail(exact)!

    expect(out).toBe(exact)
    expect(out.endsWith("…")).toBe(false)
  })

  it("coerces a non-string throw rather than dropping it", () => {
    expect(summarizeErrorDetail({ toString: () => "weird upstream object" })).toBe("weird upstream object")
    expect(summarizeErrorDetail(503)).toBe("503")
  })
})

function makeMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    model: "sonnet",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 5,
    proxyOverheadMs: 12,
    ttfbMs: 120,
    upstreamDurationMs: 800,
    totalDurationMs: 850,
    contentBlocks: 3,
    textEvents: 10,
    error: null,
    ...overrides,
  }
}

describe("error detail survives the SQLite round trip", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function freshDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "meridian-errdetail-"))
    dirs.push(dir)
    return join(dir, "telemetry.db")
  }

  it("persists the detail alongside the classified type", () => {
    const stores = createSqliteStores(freshDb(), 7)
    try {
      stores.telemetry.record(makeMetric({
        requestId: "r-fail",
        status: 400,
        error: "invalid_request_error",
        errorDetail: "prompt is too long: 234567 tokens > 200000 maximum",
      }))

      const [read] = stores.telemetry.getRecent({ limit: 1 })
      expect(read!.error).toBe("invalid_request_error")
      expect(read!.errorDetail).toBe("prompt is too long: 234567 tokens > 200000 maximum")
    } finally {
      stores.close()
    }
  })

  it("leaves the detail undefined on a successful request", () => {
    const stores = createSqliteStores(freshDb(), 7)
    try {
      stores.telemetry.record(makeMetric({ requestId: "r-ok" }))

      const [read] = stores.telemetry.getRecent({ limit: 1 })
      expect(read!.error).toBeNull()
      expect(read!.errorDetail).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it("reopens a database written before the column existed", () => {
    // The migration is additive and swallows "duplicate column", so the real
    // risk is the second open, not the first: reopening must not throw and must
    // still read rows that predate the column.
    const dbPath = freshDb()

    const first = createSqliteStores(dbPath, 7)
    first.telemetry.record(makeMetric({ requestId: "legacy", error: "api_error" }))
    first.close()

    const second = createSqliteStores(dbPath, 7)
    try {
      const [read] = second.telemetry.getRecent({ limit: 1 })
      expect(read!.requestId).toBe("legacy")
      expect(read!.errorDetail).toBeUndefined()
    } finally {
      second.close()
    }
  })
})

/**
 * Renders the dashboard's inline client script against DOM stubs, capturing
 * every innerHTML write rather than only the last one — the requests table and
 * the summary panel both write through the same stubbed element.
 */
function renderRequestsTable(reqs: unknown[]): string {
  const script = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]!)
    .find(body => body.includes("function render("))
  if (!script) throw new Error("dashboard has no inline <script> defining render()")

  const writes: string[] = []
  const element = {
    addEventListener() {},
    value: "",
    checked: false,
    get innerHTML() { return "" },
    set innerHTML(v: string) { writes.push(v) },
  }

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
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined
      return key in target ? target[key as string] : anything
    },
  })

  // Compute the summary from the same metrics rather than hand-stubbing its
  // shape: a stub drifts silently when a field is added, and the renderer reads
  // the summary before it ever reaches the requests table.
  const summary = computeSummary(reqs as RequestMetric[], 3_600_000)

  const factory = new Function(
    "scope",
    `with (scope) { ${script}\n; return render }`
  ) as (scope: unknown) => (s: TelemetrySummary, reqs: unknown[], logs: unknown[], sessions?: unknown) => void

  factory(scope)(summary, reqs, [], undefined)
  return writes.join("\n")
}

describe("dashboard surfaces the error detail", () => {
  it("hangs the detail off the status cell as a tooltip", () => {
    const html = renderRequestsTable([makeMetric({
      status: 400,
      error: "invalid_request_error",
      errorDetail: "prompt is too long: 234567 tokens > 200000 maximum",
    })])

    expect(html).toContain("invalid_request_error")
    expect(html).toContain('title="prompt is too long: 234567 tokens &gt; 200000 maximum"')
  })

  it("escapes the detail — upstream text is arbitrary and lands in an attribute", () => {
    const html = renderRequestsTable([makeMetric({
      status: 400,
      error: "invalid_request_error",
      errorDetail: 'bad "quoted" <script>alert(1)</script>',
    })])

    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&quot;quoted&quot;")
    expect(html).toContain("&lt;script&gt;")
  })

  it("emits no title attribute on a request that succeeded", () => {
    const html = renderRequestsTable([makeMetric({ status: 200, error: null })])
    expect(html).not.toContain("title=\"")
  })
})
