/**
 * Telemetry types for request performance tracking.
 *
 * Each proxy request produces a RequestMetric capturing timing for every phase:
 *
 *   queueEnter → queueStart → requestStart ──→ upstreamStart → firstChunk → done
 *   ├─ queueWait ─┤           ├─ proxyOverhead ─┤              │            │
 *   │                                            ├──── TTFB ────┤            │
 *   │                                            ├── upstream duration ──────┤
 *   ├──────────────────── total duration ────────────────────────────────────┤
 */

export interface RequestMetric {
  /** Unique request identifier */
  requestId: string

  /** When this metric was recorded */
  timestamp: number

  /** Which agent adapter handled this request */
  adapter?: string

  /** Optional client-stamped source tag (x-meridian-source) for distinguishing
   *  concurrent flows within the same conversation (e.g. main chat vs.
   *  memory-extract fork vs. subagent-scout). Truncated to 64 chars. */
  requestSource?: string

  /** Model used for SDK query (sonnet, opus, haiku, sonnet[1m], etc.) */
  model: string

  /** Original model string from the client request (e.g. "claude-sonnet-4-6-20250312") */
  requestModel?: string

  /** Profile that served the request (multi-account); absent on early
   *  parse-error records where profile resolution never ran. */
  profileId?: string

  /** Streaming or non-streaming */
  mode: "stream" | "non-stream"

  /** Envelope-integrity violations detected on this response (dangling_block,
   *  undelivered_tool_use, empty_tool_input). Absent when the envelope was
   *  clean — the overwhelmingly common case. See proxy/envelopeIntegrity.ts. */
  envelopeViolations?: string[]

  /** Whether the request used session resume */
  isResume: boolean

  /** Whether passthrough mode was active */
  isPassthrough: boolean

  /** Session lineage classification: how the incoming messages related to the stored session.
   *  - continuation: normal follow-up (prefix matched)
   *  - compaction:   older messages rewritten, recent preserved (suffix matched)
   *  - undo:         user undid recent messages (prefix preserved, suffix changed) → SDK fork
   *  - diverged:     no overlap with stored session → fresh start
   *  - new:          first request, no stored session to compare */
  lineageType?: "continuation" | "compaction" | "undo" | "diverged" | "new"

  /** Whether deferred tool loading was active (auto-defer or client defer_loading) */
  hasDeferredTools?: boolean

  /** Number of tools deferred (not in prompt, discoverable via ToolSearch) */
  deferredToolCount?: number

  /** Total number of tools in the request */
  toolCount?: number

  /** Tool names discovered via ToolSearch this request (deferred tools that got called) */
  discoveredTools?: string[]

  /** Cumulative count of tools discovered via ToolSearch across the entire session */
  sessionDiscoveredCount?: number

  /** Number of messages in the request */
  messageCount?: number

  /** SDK session ID used for this request (for correlating across turns) */
  sdkSessionId?: string
  /**
   * The client's own conversation id (OpenCode's session id, profile-scoped),
   * which is what meridian keys its session cache on.
   *
   * Distinct from sdkSessionId on purpose: every resumed turn gets a *fresh*
   * Claude SDK session id, so sdkSessionId identifies one upstream call, not
   * the conversation it belongs to. Grouping by it puts every turn in its own
   * bucket. This is the id that stays put across turns.
   */
  clientSessionId?: string

  /** HTTP status code returned to the client */
  status: number

  /** Time spent waiting in the concurrency queue (ms) */
  queueWaitMs: number

  /** Time spent in proxy processing before SDK call — request parsing,
   *  session lookup, prompt building (ms). If this is high, the proxy
   *  is the bottleneck. Typically <50ms. */
  proxyOverheadMs: number

  /** Time from SDK query start to first content chunk (ms) */
  ttfbMs: number | null

  /** Total time the SDK query took (ms) */
  upstreamDurationMs: number

  /** Total time from request received to response sent (ms) */
  totalDurationMs: number

  /** Number of content blocks in the response */
  contentBlocks: number

  /** Number of text stream events forwarded (streaming only) */
  textEvents: number

  /** Error type if the request failed, null if successful */
  error: string | null

  /** The upstream error text behind `error`, collapsed to one line and bounded
   *  by `MAX_ERROR_DETAIL_LENGTH`. Absent on success, and on failures whose
   *  cause produced no message. `error` says which class of thing went wrong and
   *  is what the breakdown aggregates on; this says what actually happened, and
   *  is per-record precisely so it never reaches an aggregation key. */
  errorDetail?: string

  /** Input tokens consumed (from SDK usage) */
  inputTokens?: number

  /** Output tokens generated */
  outputTokens?: number

  /** Input tokens read from prompt cache (lower cost) */
  cacheReadInputTokens?: number

  /** Input tokens written to prompt cache (one-time cost) */
  cacheCreationInputTokens?: number

  /** Cache hit ratio: cacheRead / (cacheRead + cacheCreation + uncached).
   *  1.0 = perfect caching, 0.0 = no caching. undefined when no token data. */
  cacheHitRate?: number
}

export interface PhaseTiming {
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  avg: number
}

/** Per-model token totals and estimated cost at static API list prices. */
export interface ModelCostBreakdown {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Estimated USD for this model's requests; null when the model has no pricing entry */
  estimatedUsd: number | null
}

/** Aggregate cost estimate across a window. Estimates only: Claude Max
 *  usage is covered by the subscription; this is the equivalent API cost. */
export interface CostEstimate {
  /** Sum across all priced models (unpriced models excluded) */
  totalUsd: number
  /** Keyed by requestModel || model, matching TelemetrySummary.byModel */
  byModel: Record<string, ModelCostBreakdown>
  /** Requests whose model had no pricing entry, excluded from totalUsd */
  unpricedRequestCount: number
  /** Per-profile rollup (multi-account): estimated USD + request count.
   *  Keyed by RequestMetric.profileId, "default" when absent. */
  byProfile: Record<string, { requests: number; estimatedUsd: number }>
}

export interface TelemetrySummary {
  /** Time window these stats cover */
  windowMs: number
  /** Total requests in the window */
  totalRequests: number
  /** Requests that returned an error */
  errorCount: number
  /** Error counts keyed by classified error type (`upstream_timeout`,
   *  `invalid_request_error`, ...). Bounded: the vocabulary is the classifier's,
   *  not free-form messages. An error rate on its own says nothing actionable —
   *  a window of `upstream_timeout` and a window of `authentication_error` need
   *  opposite responses. */
  byError: Record<string, number>
  /** Total envelope-integrity violations across the window (dangling blocks,
   *  undelivered tool calls, empty required inputs). 0 = wire contract clean. */
  envelopeViolationCount: number
  /** Requests per minute */
  requestsPerMinute: number

  /** Timing breakdowns by phase */
  queueWait: PhaseTiming
  proxyOverhead: PhaseTiming
  ttfb: PhaseTiming
  upstreamDuration: PhaseTiming
  totalDuration: PhaseTiming

  /** Breakdown by model */
  byModel: Record<string, { count: number; avgTotalMs: number }>
  /** Breakdown by mode */
  byMode: Record<string, { count: number; avgTotalMs: number }>

  /** Aggregate token usage across all requests in the window */
  tokenUsage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheCreationTokens: number
    avgCacheHitRate: number
    /** Requests where cache hit rate was 0 despite being a resume */
    cacheMissOnResumeCount: number
  }

  /** Estimated cost of the window's usage at static API list prices */
  costEstimate: CostEstimate
}

/** One request shape a session sent more than once. */
export interface SessionShapeRepeat {
  /** Model the repeated requests went to (requestModel when the client sent one) */
  model: string
  /** Conversation length shared by every occurrence */
  messageCount: number
  /** How many times the shape was sent; always >= 2 */
  occurrences: number
  /** Upstream time spent on the occurrences after the first (ms) */
  repeatedUpstreamMs: number
}

/** One SDK session's requests, rolled up. */
export interface SessionGroup {
  /**
   * The conversation's id: the client's own session id where the request
   * carried one, otherwise the SDK session id as a fallback.
   *
   * Preferring the client id matters. Every resumed turn is issued a fresh SDK
   * session id, so grouping on that alone puts each turn in a bucket of one and
   * a loop never forms.
   */
  sessionId: string
  /** Adapter that served the session; the first one seen if it varied */
  adapter?: string
  /** Client-stamped source tag, when one was sent */
  requestSource?: string
  /** Most-used model in the session */
  model: string
  requests: number
  errorCount: number
  /** Oldest and newest request timestamps within the window */
  firstTimestamp: number
  lastTimestamp: number
  /** Total upstream (SDK) time across the session's requests (ms) */
  upstreamMs: number
  /** Upstream time that bought nothing: errored requests, plus every repeat of
   *  a shape after its first occurrence. A request that is both is counted
   *  once. */
  wastedUpstreamMs: number
  /** Repeated shapes, most-repeated first. Empty when the session never resent
   *  a state — the ordinary case. */
  repeats: SessionShapeRepeat[]
}

/** Session rollup over a window. */
export interface SessionGroupsReport {
  /** Sessions in the window, worst wasted time first */
  sessions: SessionGroup[]
  /** Requests carrying neither a client nor an SDK session id. They cannot be
   *  grouped, so a high count
   *  means this view is only telling part of the story. */
  ungroupedRequests: number
  /** Sum of wastedUpstreamMs across every session */
  totalWastedUpstreamMs: number
}

/** Storage backend for request metrics. */
export interface ITelemetryStore {
  /** Record a completed request metric. */
  record(metric: RequestMetric): void
  /** Number of stored metrics. */
  readonly size: number
  /** Retrieve recent metrics, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    model?: string
  }): RequestMetric[]
  /** Find the latest successful metric for a given SDK session. */
  getLastForSession(sdkSessionId: string): RequestMetric | undefined
  /** Compute aggregate statistics over a time window. */
  summarize(windowMs?: number): TelemetrySummary
  /** Clear all stored metrics. */
  clear(): void
}

/** Diagnostic log entry. */
export interface DiagnosticLog {
  /** Unix timestamp */
  timestamp: number
  /** Log level */
  level: "info" | "warn" | "error"
  /** Log category for filtering */
  category: "session" | "lineage" | "error" | "lifecycle" | "token"
  /** Request ID (if associated with a request) */
  requestId?: string
  /** Human-readable message */
  message: string
}

/** Storage backend for diagnostic logs. */
export interface IDiagnosticLogStore {
  /** Append a log entry (timestamp is added automatically). */
  log(entry: Omit<DiagnosticLog, "timestamp">): void
  /** Log a session event. */
  session(message: string, requestId?: string): void
  /** Log a lineage event (compaction, undo, diverged). */
  lineage(message: string, requestId?: string): void
  /** Log an error. */
  error(message: string, requestId?: string): void
  /** Retrieve recent logs, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    category?: string
  }): DiagnosticLog[]
  /** Clear all stored logs. */
  clear(): void
}
