/**
 * Wiring test for `RequestMetric.errorDetail` — the two failure paths in
 * server.ts that populate it.
 *
 * The unit tests in telemetry-error-detail.test.ts cover summarizeErrorDetail,
 * the SQLite column and the dashboard tooltip. None of them prove the field is
 * ever *populated in production*: delete either `errorDetail:` line from
 * server.ts and every one of them still passes. That is the regression this
 * file exists to catch, so it asserts through HTTP against the real record —
 * upstream error text in, detail out — for both the outer catch (non-streaming)
 * and the mid-stream error path.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { messageStart, textBlockStart, textDelta } from "./helpers"

/** Distinctive enough that a substring assertion can't pass by accident. */
const UPSTREAM_ERROR = "gateway-7 refused the request: connection reset by peer"

/** Whether the SDK fails at all, and if so whether it fails mid-stream. */
let shouldFail = true
let failMidStream = false

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    const isStreaming = opts.options?.includePartialMessages === true
    return (async function* () {
      if (shouldFail) {
        if (failMidStream && isStreaming) {
          yield messageStart("msg-1")
          yield textBlockStart(0)
          yield textDelta(0, "partial")
        }
        throw new Error(UPSTREAM_ERROR)
      }
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sdk-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

function post(body: any, headers: Record<string, string> = {}) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

/** The single failed metric recorded by the request just made. */
function failedMetric() {
  const failed = telemetryStore.getRecent({ limit: 50 }).filter((m) => m.error !== null)
  expect(failed.length).toBe(1)
  return failed[0]!
}

describe("errorDetail wiring (server.ts record sites)", () => {
  beforeEach(() => {
    clearSessionCache()
    telemetryStore.clear()
    shouldFail = true
    failMidStream = false
  })

  it("records the upstream error text on the non-streaming failure path", async () => {
    const res = await post({ model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] })
    expect(res.ok).toBe(false)

    const metric = failedMetric()
    // The classified type is the aggregation key and stays coarse...
    expect(typeof metric.error).toBe("string")
    expect(metric.error).not.toContain("gateway-7")
    // ...the detail is the only thing carrying what actually happened.
    expect(metric.errorDetail).toContain("gateway-7")
    expect(metric.errorDetail).toContain("connection reset by peer")
  })

  it("records the upstream error text on the mid-stream failure path", async () => {
    failMidStream = true
    const res = await post({ model: "sonnet", stream: true, messages: [{ role: "user", content: "hi" }] })
    await res.text() // drain the SSE body so the stream finalizes and records

    const metric = failedMetric()
    expect(metric.errorDetail).toContain("gateway-7")
  })

  it("leaves errorDetail unset on success", async () => {
    shouldFail = false
    const res = await post({ model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)

    // A healthy request must not carry a detail, or the dashboard grows
    // tooltips on rows that have nothing to explain.
    const succeeded = telemetryStore.getRecent({ limit: 50 }).filter((m) => m.error === null)
    expect(succeeded.length).toBe(1)
    expect(succeeded[0]!.errorDetail).toBeUndefined()
  })
})
