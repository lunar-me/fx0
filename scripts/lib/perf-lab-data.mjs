// Data core for the fx0 performance lab. Pure functions: no I/O, network, model, or Chrome calls.
// Browser and server events stay on their own process clocks; no cross-clock subtraction happens here.
import { randomBytes } from 'node:crypto'
import { sanitizeTraceSnapshot } from '../../lib/performance-trace.ts'
import { inspectCapture } from '../perf-e2e.mjs'

const METRIC_NAMES = ['sendingMs', 'firstTextMs', 'firstDraftMs', 'finishedMs', 'previewMs']
const STATUSES = new Set(['complete', 'incomplete', 'failed'])
const ISSUE_CODES = new Set([
  'browser_root_missing', 'browser_inconsistent', 'prompt_failed', 'prompt_cancelled', 'prompt_incomplete',
  'dropped_browser', 'dropped_server', 'server_missing', 'server_unmatched', 'server_failed', 'event_rejected',
])
const ENVIRONMENTS = ['local-development', 'local-production', 'vercel-preview', 'unknown']
const DURABILITY = ['local-file', 'vercel', 'unknown']
const CONDITIONS = ['cold', 'warm', 'unknown']
const HISTORY = ['new-chat', 'follow-up', 'unknown']
const CAPTURES = ['manual', 'headless']
const METADATA_FIELDS = ['environment', 'durability', 'condition', 'workload', 'workloadHash', 'model', 'reasoningEffort',
  'fast', 'accountHash', 'teamHash', 'viewport', 'revision', 'sourceHash', 'instrumentation', 'history', 'capture', 'startBoundary']
// Settings that must be known and identical across every run before any delta is computed.
const SETTING_FIELDS = METADATA_FIELDS.filter(field => field !== 'revision' && field !== 'sourceHash')
const INSTRUMENTATION = 'fx0-trace-v1'
const START_BOUNDARY = 'handler'

const HEX64 = /^[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{7,40}$/
const WORKLOAD = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,2}$/
const EFFORT = /^[a-z][a-z0-9-]{0,15}$/
const LABEL = /^[a-z][a-z0-9-]{0,31}$/
const PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const RUN_ID = /^[a-f0-9]{32}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const SEED = /^[A-Za-z0-9._-]{1,64}$/

// Errors name the offending field, never its value, so rejected input (a URL, a prompt) is not echoed.
function fail(message) {
  throw new TypeError(message)
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNumber = value => typeof value === 'number' && Number.isFinite(value)

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Nearest-rank percentile; the median uses the average of the middle pair for even counts.
function summarize(values) {
  if (!values.length) return { n: 0, p50: null, p95: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: round(median(sorted), 3),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], 3),
  }
}

function cleanLabel(value) {
  if (typeof value !== 'string' || !LABEL.test(value)) fail('Invalid run label')
  return value
}

function cleanPairId(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !PAIR_ID.test(value)) fail('Invalid pairId')
  return value
}

function cleanRecordedAt(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) fail('recordedAt must be an ISO-8601 UTC timestamp')
  return new Date(value).toISOString()
}

function cleanKnownText(value, pattern, field) {
  if (value === 'unknown') return value
  if (typeof value !== 'string' || !pattern.test(value)) fail(`Invalid run metadata field: ${field}`)
  return value
}

function cleanNullableHash(value, field) {
  if (value === null) return null
  if (typeof value !== 'string' || !HEX64.test(value)) fail(`Invalid run metadata field: ${field}`)
  return value
}

function cleanNullableRevision(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail('Invalid run metadata field: revision')
  return value
}

function cleanViewport(value) {
  if (value === null) return null
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'dpr,height,width') fail('Invalid run metadata field: viewport')
  const { width, height, dpr } = value
  if (!Number.isSafeInteger(width) || width < 1 || width > 10000 || !Number.isSafeInteger(height) || height < 1 || height > 10000 ||
      !isNumber(dpr) || dpr < 0.5 || dpr > 8) fail('Invalid run metadata field: viewport')
  return { width, height, dpr }
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) fail(`Invalid run metadata field: ${field}`)
  return value
}

// Metadata is a closed schema. Unknown keys, URLs, paths, and freeform text are rejected, not stored.
function cleanMetadata(input) {
  if (!isRecord(input)) fail('Run metadata must be an object')
  const keys = Object.keys(input)
  if (keys.length !== METADATA_FIELDS.length || METADATA_FIELDS.some(field => !keys.includes(field))) {
    fail('Run metadata must contain exactly the fixed fields')
  }
  const model = input.model
  if (model !== 'unknown' && (typeof model !== 'string' || model.length > 128 || !MODEL.test(model) || model.includes('..'))) {
    fail('Invalid run metadata field: model')
  }
  if (typeof input.fast !== 'boolean' && input.fast !== null) fail('Invalid run metadata field: fast')
  if (input.instrumentation !== INSTRUMENTATION) fail('Invalid run metadata field: instrumentation')
  if (input.startBoundary !== START_BOUNDARY) fail('Invalid run metadata field: startBoundary')
  return {
    environment: oneOf(input.environment, ENVIRONMENTS, 'environment'),
    durability: oneOf(input.durability, DURABILITY, 'durability'),
    condition: oneOf(input.condition, CONDITIONS, 'condition'),
    workload: cleanKnownText(input.workload, WORKLOAD, 'workload'),
    workloadHash: cleanNullableHash(input.workloadHash, 'workloadHash'),
    model,
    reasoningEffort: cleanKnownText(input.reasoningEffort, EFFORT, 'reasoningEffort'),
    fast: input.fast,
    accountHash: cleanNullableHash(input.accountHash, 'accountHash'),
    teamHash: cleanNullableHash(input.teamHash, 'teamHash'),
    viewport: cleanViewport(input.viewport),
    revision: cleanNullableRevision(input.revision),
    sourceHash: cleanNullableHash(input.sourceHash, 'sourceHash'),
    instrumentation: INSTRUMENTATION,
    history: oneOf(input.history, HISTORY, 'history'),
    capture: oneOf(input.capture, CAPTURES, 'capture'),
    startBoundary: START_BOUNDARY,
  }
}

function emptyMetrics() {
  return Object.fromEntries(METRIC_NAMES.map(name => [name, null]))
}

function cleanMetrics(metrics, status) {
  if (!isRecord(metrics) || Object.keys(metrics).length !== METRIC_NAMES.length) fail('Invalid run metrics')
  const out = {}
  for (const name of METRIC_NAMES) {
    const value = metrics[name]
    if (value !== null && (!isNumber(value) || value < 0)) fail('Invalid run metrics')
    out[name] = value
  }
  // A failed, incomplete, or dropped run must not carry latency numbers that look like a measurement.
  if (status !== 'complete' && METRIC_NAMES.some(name => out[name] !== null)) fail('Non-complete run reports metrics')
  return out
}

// Re-validates a run object produced by createRun (or a stored copy). Throws on any drift from the contract.
function checkRun(run) {
  if (!isRecord(run) || run.version !== 1) fail('Invalid performance run')
  if (typeof run.id !== 'string' || !RUN_ID.test(run.id)) fail('Invalid run id')
  cleanLabel(run.label)
  cleanPairId(run.pairId)
  cleanRecordedAt(run.recordedAt)
  if (!STATUSES.has(run.status)) fail('Invalid run status')
  if (!Array.isArray(run.issues) || run.issues.some(issue => !ISSUE_CODES.has(issue))) fail('Invalid run issues')
  const metadata = cleanMetadata(run.metadata)
  const metrics = cleanMetrics(run.metrics, run.status)
  if (!isRecord(run.trace)) fail('Invalid run trace')
  const trace = sanitizeTraceSnapshot(run.trace)
  if (trace.rejected > 0) fail('Invalid run trace')
  return { metadata, metrics, traceEvents: trace.traceEvents, dropped: trace.dropped }
}

const FLAG_EVENTS = new Set(['prompt.send', 'prompt.turn', 'prompt.e2e', 'prompt.finished'])

function serverBatches(server) {
  if (server === null || server === undefined) return []
  return Array.isArray(server) ? server : [server]
}

// Builds one comparable run from a single browser capture and any server batches. The browser
// root's traceId is the run id; server events join only through that exact traceId.
export function createRun({ browser, server = null, metadata, label = 'baseline', pairId = null, recordedAt } = {}) {
  const runMetadata = cleanMetadata(metadata)
  const runLabel = cleanLabel(label)
  const runPairId = cleanPairId(pairId)
  const runRecordedAt = cleanRecordedAt(recordedAt)

  const browserTrace = sanitizeTraceSnapshot(browser)
  const browserEvents = browserTrace.traceEvents.filter(event => event.pid === 'browser')
  let rejected = browserTrace.rejected + browserTrace.traceEvents.length - browserEvents.length
  let dropped = browserTrace.dropped

  const serverEvents = []
  let serverDropped = 0
  for (const batch of serverBatches(server)) {
    const clean = sanitizeTraceSnapshot(batch)
    const lanes = clean.traceEvents.filter(event => event.pid.startsWith('server:'))
    rejected += clean.rejected + clean.traceEvents.length - lanes.length
    for (const event of lanes) serverEvents.push(event)
    serverDropped += clean.dropped
  }
  dropped += serverDropped

  const starts = browserEvents.filter(event => event.name === 'prompt.started' && event.ph === 'i')
  const roots = browserEvents.filter(event => event.name === 'prompt.e2e' && event.ph === 'X')
  if (starts.length > 1 || roots.length > 1) fail('Browser capture contains more than one prompt; capture one turn per run')
  const rootTraceId = starts[0]?.args.traceId ?? null

  const issues = new Set()
  const flagged = browserEvents.filter(event => FLAG_EVENTS.has(event.name) &&
    Boolean(event.args.failed || event.args.cancelled || event.args.incomplete))
  if (flagged.some(event => event.args.failed)) issues.add('prompt_failed')
  if (flagged.some(event => event.args.cancelled)) issues.add('prompt_cancelled')
  if (flagged.some(event => event.args.incomplete)) issues.add('prompt_incomplete')
  const failed = flagged.some(event => event.args.failed || event.args.cancelled)

  // inspectCapture is the single browser milestone authority; it throws on inconsistent captures.
  let capture = { complete: false }
  if (rootTraceId === null) issues.add('browser_root_missing')
  else if (!flagged.length) {
    try {
      capture = inspectCapture({ traceEvents: browserEvents, dropped: browserTrace.dropped }, null)
    } catch {
      issues.add('browser_inconsistent')
    }
    if (!capture.complete && !issues.has('browser_inconsistent')) issues.add('browser_root_missing')
  }

  const matched = []
  let unmatched = 0
  for (const event of serverEvents) {
    if (rootTraceId !== null && event.args.traceId === rootTraceId) matched.push(event)
    else unmatched++
  }
  if (!matched.length) issues.add('server_missing')
  if (unmatched) issues.add('server_unmatched')
  if (matched.some(event => event.args.failed || event.args.cancelled || event.args.incomplete)) issues.add('server_failed')
  if (browserTrace.dropped > 0) issues.add('dropped_browser')
  if (serverDropped > 0) issues.add('dropped_server')
  if (rejected > 0) issues.add('event_rejected')

  let status
  if (failed) status = 'failed'
  else if (flagged.length || !capture.complete || dropped > 0) status = 'incomplete'
  else status = 'complete'

  let metrics = emptyMetrics()
  if (status === 'complete') {
    const send = browserEvents.find(event => event.name === 'prompt.send' && event.ph === 'X' && event.args.traceId === rootTraceId)
    const milestones = capture.milestonesMs
    const candidate = {
      sendingMs: send ? send.dur / 1000 : null,
      firstTextMs: milestones['prompt.first_content'],
      firstDraftMs: milestones['prompt.first_draft'],
      finishedMs: milestones['prompt.finished'],
      previewMs: capture.finalArtifactPaintMs,
    }
    if (METRIC_NAMES.some(name => candidate[name] !== null && candidate[name] < 0)) {
      status = 'incomplete'
      issues.add('browser_inconsistent')
    } else {
      metrics = Object.fromEntries(METRIC_NAMES.map(name => [name, candidate[name] === null ? null : round(candidate[name], 3)]))
    }
  }

  const traceEvents = [...browserEvents]
  for (const event of matched) traceEvents.push(event)
  return {
    version: 1,
    id: rootTraceId ?? randomBytes(16).toString('hex'),
    label: runLabel,
    pairId: runPairId,
    recordedAt: runRecordedAt,
    status,
    issues: [...issues].sort(),
    metadata: runMetadata,
    metrics,
    trace: { traceEvents, displayTimeUnit: 'ms', dropped },
  }
}

const SETTING_CODE = field => field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
const isUnknownSetting = value => value === null || value === undefined || value === 'unknown'

function pairStatus(baseline, candidate) {
  if (!baseline || !candidate) return 'unpaired'
  if (baseline.status === 'complete' && candidate.status === 'complete') return 'valid'
  if (baseline.status === 'failed' || candidate.status === 'failed') return 'failed'
  return 'incomplete'
}

function metricRow(name, validBaselines, validCandidates, validPairs) {
  const deltas = []
  const baselineValues = []
  for (const pair of validPairs) {
    const before = pair.baseline.metrics[name]
    const after = pair.candidate.metrics[name]
    if (isNumber(before) && isNumber(after)) {
      baselineValues.push(before)
      deltas.push(after - before)
    }
  }
  const delta = deltas.length ? median(deltas) : null
  const baselineMedian = baselineValues.length ? median(baselineValues) : null
  return {
    name,
    baseline: summarize(validBaselines.map(run => run.metrics[name]).filter(isNumber)),
    candidate: summarize(validCandidates.map(run => run.metrics[name]).filter(isNumber)),
    // Paired B-A (candidate minus baseline). Negative means the candidate was quicker.
    pairedDeltaMs: delta === null ? null : round(delta, 3),
    improvementPercent: delta === null || !baselineMedian ? null : round(-delta / baselineMedian * 100, 2),
  }
}

// Compares baseline (A) and candidate (B) runs. Runs pair only by an explicit, unique pairId.
// Failed, incomplete, and unpaired runs stay in the result and in counts; only complete pairs enter deltas.
export function compareRuns(baselines, candidates) {
  if (!Array.isArray(baselines) || !Array.isArray(candidates)) fail('compareRuns expects arrays of runs')
  const seen = new Set()
  const view = run => {
    const checked = checkRun(run)
    if (seen.has(run.id)) fail('Run id is reused; each trace may appear once')
    seen.add(run.id)
    return { id: run.id, status: run.status, pairId: run.pairId, metadata: checked.metadata, metrics: checked.metrics }
  }
  baselines = baselines.map(view)
  candidates = candidates.map(view)
  const reasons = []
  if (!baselines.length) reasons.push('baseline_missing')
  if (!candidates.length) reasons.push('candidate_missing')

  const all = [...baselines, ...candidates]
  for (const field of SETTING_FIELDS) {
    const values = all.map(run => run.metadata[field])
    const code = SETTING_CODE(field)
    if (values.some(isUnknownSetting)) reasons.push(`${code}_unknown`)
    else if (new Set(values.map(value => JSON.stringify(value))).size > 1) reasons.push(`${code}_mismatch`)
  }
  for (const [field, code] of [['revision', 'revision'], ['sourceHash', 'source_hash']]) {
    if (all.some(run => run.metadata[field] === null)) reasons.push(`${code}_missing`)
    for (const side of [baselines, candidates]) {
      if (new Set(side.map(run => run.metadata[field])).size > 1) reasons.push(`${code}_mixed`)
    }
  }

  const byPair = new Map()
  const unpairedRuns = []
  for (const [side, runs] of [['baseline', baselines], ['candidate', candidates]]) {
    for (const run of runs) {
      if (run.pairId === null) {
        unpairedRuns.push({ pairId: null, baseline: side === 'baseline' ? run : null, candidate: side === 'candidate' ? run : null })
        continue
      }
      const entry = byPair.get(run.pairId) ?? { pairId: run.pairId, baseline: null, candidate: null }
      if (entry[side]) fail(`Duplicate pairId in ${side} runs`)
      entry[side] = run
      byPair.set(run.pairId, entry)
    }
  }
  const sorted = [...byPair.values()].sort((a, b) => a.pairId.localeCompare(b.pairId, 'en', { numeric: true }))
  const entries = [...sorted, ...unpairedRuns].map(entry => ({ ...entry, status: pairStatus(entry.baseline, entry.candidate) }))
  const pairs = entries.map(entry => ({
    pairId: entry.pairId,
    baselineId: entry.baseline?.id ?? null,
    candidateId: entry.candidate?.id ?? null,
    status: entry.status,
  }))
  const valid = entries.filter(entry => entry.status === 'valid')
  const counts = {
    baseline: baselines.length,
    candidate: candidates.length,
    paired: entries.filter(entry => entry.baseline && entry.candidate).length,
    valid: valid.length,
    failed: all.filter(run => run.status === 'failed').length,
    unpaired: entries.filter(entry => entry.status === 'unpaired')
      .reduce((sum, entry) => sum + (entry.baseline ? 1 : 0) + (entry.candidate ? 1 : 0), 0),
  }
  const compatible = reasons.length === 0
  const validBaselines = baselines.filter(run => run.status === 'complete')
  const validCandidates = candidates.filter(run => run.status === 'complete')
  const metrics = compatible && valid.length
    ? METRIC_NAMES.map(name => metricRow(name, validBaselines, validCandidates, valid))
    : []
  // Same source hash on both sides is an A/A control: its deltas measure noise, not an improvement.
  const control = compatible && valid.length > 0 && baselines[0].metadata.sourceHash === candidates[0].metadata.sourceHash
  return {
    compatible,
    reasons: [...new Set(reasons)],
    pairs,
    counts,
    metrics,
    control,
    smallSample: valid.length < 5,
  }
}

// Balanced, seeded pair order: AB and BA differ by at most one, and the order is shuffled reproducibly.
const AB = Object.freeze(['baseline', 'candidate'])
const BA = Object.freeze(['candidate', 'baseline'])

function seedText(seed) {
  if (typeof seed === 'string' && SEED.test(seed)) return seed
  if (Number.isSafeInteger(seed) && seed >= 0) return String(seed)
  fail('seed must be a short string or a non-negative integer')
}

// FNV-1a over the seed text, then mulberry32. Both are fixed arithmetic, so schedules reproduce across Node versions.
function hashSeed(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(state) {
  let value = state
  return () => {
    value = (value + 0x6d2b79f5) | 0
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function makeSchedule(pairs, seed) {
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 100) fail('pairs must be an integer from 1 to 100')
  const random = mulberry32(hashSeed(seedText(seed)))
  const half = Math.floor(pairs / 2)
  const orders = [...Array(half).fill(AB), ...Array(half).fill(BA)]
  if (pairs % 2) orders.push(random() < 0.5 ? AB : BA)
  for (let index = orders.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[orders[index], orders[other]] = [orders[other], orders[index]]
  }
  return orders.map((order, index) => ({ pairId: String(index + 1), order: [...order] }))
}

// Chrome Trace Event export. Lanes get numeric pids and generic names (Browser, Server1...), never machine paths.
export function exportChromeTrace(run) {
  const checked = checkRun(run)
  const lanes = [...new Set(checked.traceEvents.map(event => event.pid))]
    .sort((a, b) => (a === 'browser' ? 0 : 1) - (b === 'browser' ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0))
  const pidOf = new Map()
  const traceEvents = []
  let serverIndex = 0
  lanes.forEach((lane, index) => {
    const pid = index + 1
    pidOf.set(lane, pid)
    const name = lane === 'browser' ? 'Browser' : `Server${++serverIndex}`
    traceEvents.push({ name: 'process_name', ph: 'M', ts: 0, pid, tid: 1, args: { name } })
  })
  for (const event of checked.traceEvents) {
    traceEvents.push({
      name: event.name, cat: 'fx0', ph: event.ph, ts: event.ts,
      ...(event.ph === 'X' ? { dur: event.dur } : { s: 't' }),
      pid: pidOf.get(event.pid), tid: 1, args: { ...event.args },
    })
  }
  return {
    traceEvents,
    displayTimeUnit: 'ms',
    otherData: {
      id: run.id, label: run.label, pairId: run.pairId, status: run.status, issues: [...run.issues],
      recordedAt: run.recordedAt, dropped: checked.dropped,
      clock: 'Each lane keeps its own process clock; cross-lane alignment is approximate and is not network latency.',
    },
  }
}
