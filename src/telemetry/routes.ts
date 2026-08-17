/**
 * Telemetry API routes.
 *
 * GET /telemetry            — HTML dashboard
 * GET /telemetry/requests   — Recent request metrics (JSON)
 * GET /telemetry/summary    — Aggregate statistics (JSON)
 * GET /telemetry/sessions  — Per-session rollup: loops and wasted time (JSON)
 * GET /telemetry/logs       — Diagnostic logs (JSON)
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import type { Context } from "hono"
import { telemetryStore, diagnosticLog } from "./index"
import { dashboardHtml } from "./dashboard"
import { computeSessionGroups } from "./sessionGroups"

// Read once at module load — src/telemetry/ is two levels below the package root
const _iconPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "icon.svg")
const _iconSvg = existsSync(_iconPath) ? readFileSync(_iconPath, "utf-8") : null

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parse a duration: bare digits are milliseconds, or a number with an ms/s/m/h/d
 *  suffix. Returns null for anything unparseable so the caller can answer 400 —
 *  the alternative is a silent 1ms window (`1h` -> 1) or a NaN one, both of which
 *  report "0 requests, 0 errors" and read as a healthy system. */
function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim())
  if (!m) return null
  const value = Number.parseFloat(m[1]!)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * DURATION_UNITS[m[2] ?? "ms"]!)
}

/** Parse a non-negative integer, rejecting NaN-producing input. */
function parseCount(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(n) ? n : null
}

function badParam(c: Context, name: string, raw: string, expected: string) {
  return c.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Invalid "${name}" parameter: ${JSON.stringify(raw)}. Expected ${expected}.`
      }
    },
    400
  )
}

export function createTelemetryRoutes() {
  const routes = new Hono()

  // Dashboard
  routes.get("/", (c) => {
    return c.html(dashboardHtml)
  })

  // Favicon
  routes.get("/icon.svg", (c) => {
    if (!_iconSvg) return c.notFound()
    return c.body(_iconSvg, 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600",
    })
  })

  // Recent requests
  routes.get("/requests", (c) => {
    const rawLimit = c.req.query("limit")
    const limit = rawLimit ? parseCount(rawLimit) : 50
    if (limit === null) return badParam(c, "limit", rawLimit!, "a non-negative integer")

    const rawSince = c.req.query("since")
    const since = rawSince ? parseCount(rawSince) : undefined
    if (since === null) return badParam(c, "since", rawSince!, "a Unix timestamp in milliseconds")

    const model = c.req.query("model") || undefined

    const requests = telemetryStore.getRecent({
      limit: Math.min(limit, 500),
      since,
      model,
    })

    return c.json(requests)
  })

  // Aggregate summary
  routes.get("/summary", (c) => {
    const rawWindow = c.req.query("window")
    const windowMs = rawWindow ? parseDuration(rawWindow) : 3_600_000 // default 1 hour
    if (windowMs === null) {
      return badParam(c, "window", rawWindow!, "a positive duration in milliseconds, optionally suffixed ms/s/m/h/d (e.g. 3600000 or 1h)")
    }

    const summary = telemetryStore.summarize(windowMs)
    return c.json(summary)
  })

  // Per-session rollup
  routes.get("/sessions", (c) => {
    const rawWindow = c.req.query("window")
    const windowMs = rawWindow ? parseDuration(rawWindow) : 3_600_000 // default 1 hour
    if (windowMs === null) {
      return badParam(c, "window", rawWindow!, "a positive duration in milliseconds, optionally suffixed ms/s/m/h/d (e.g. 3600000 or 1h)")
    }

    const rawLimit = c.req.query("limit")
    const limit = rawLimit ? parseCount(rawLimit) : 500
    if (limit === null) return badParam(c, "limit", rawLimit!, "a non-negative integer")

    // Reads deeper than the request table's 50 rows on purpose: a loop is the
    // high-volume case, and a session that repeated itself eighty times is
    // exactly what a newest-50 view truncates away.
    const metrics = telemetryStore.getRecent({
      limit: Math.min(limit, 500),
      since: Date.now() - windowMs,
    })

    return c.json(computeSessionGroups(metrics))
  })

  // Diagnostic logs
  routes.get("/logs", (c) => {
    const rawLimit = c.req.query("limit")
    const limit = rawLimit ? parseCount(rawLimit) : 100
    if (limit === null) return badParam(c, "limit", rawLimit!, "a non-negative integer")

    const rawSince = c.req.query("since")
    const since = rawSince ? parseCount(rawSince) : undefined
    if (since === null) return badParam(c, "since", rawSince!, "a Unix timestamp in milliseconds")

    const category = c.req.query("category") || undefined

    const logs = diagnosticLog.getRecent({
      limit: Math.min(limit, 500),
      since,
      category,
    })

    return c.json(logs)
  })

  return routes
}
