import assert from 'node:assert/strict'
import test from 'node:test'
import { compareRuns, createRun, exportChromeTrace, makeSchedule } from '../scripts/lib/perf-lab-data.mjs'

const SESSION = '00000000-0000-4000-8000-000000000001'
const RECORDED_AT = '2026-10-26T17:00:00.000Z'
const ORIGIN_US = 1_000_000
const hex = n => n.toString(16).padStart(32, '0')
const hash = char => char.repeat(64)
const ALLOWED_ARGS = new Set(['traceId', 'sessionId', 'turnId', 'count', 'chars', 'bytes', 'status', 'failed', 'cancelled',
  'first', 'seq', 'revision', 'fromPost', 'duplicate', 'step', 'incomplete'])

function metadata(overrides = {}) {
  return {
    environment: 'local-development', durability: 'local-file', condition: 'warm', workload: 'bookshop-landing-v1',
    workloadHash: hash('1'), model: 'openai/gpt-5.1', reasoningEffort: 'medium', fast: false,
    accountHash: hash('2'), teamHash: hash('3'), viewport: { width: 1280, height: 800, dpr: 2 },
    revision: 'abc1234', sourceHash: hash('4'), instrumentation: 'fx0-trace-v1', history: 'new-chat',
    capture: 'headless', startBoundary: 'handler', ...overrides,
  }
}

// One browser capture of a single prompt, in the fixed event format. Times are milliseconds from the send handler.
function browserCapture({ traceId = hex(1), sendMs = 2, firstTextMs = 5, finishedMs = 100, rootArgs = {}, finishedArgs = {},
  omit = [], extra = [], dropped = 0 } = {}) {
  const at = ms => ORIGIN_US + ms * 1000
  const instant = (name, ms, args = {}) => ({ name, cat: 'fx0', ph: 'i', s: 't', ts: at(ms), pid: 'browser', tid: 1, args: { traceId, ...args } })
  const span = (name, ms, durMs, args = {}) => ({ name, cat: 'fx0', ph: 'X', ts: at(ms), dur: durMs * 1000, pid: 'browser', tid: 1, args: { traceId, ...args } })
  const events = [
    instant('prompt.started', 0),
    span('prompt.send', 0, sendMs, { sessionId: SESSION, status: 200, failed: false }),
    instant('prompt.acknowledged', sendMs),
    instant('prompt.first_content', firstTextMs),
    instant('prompt.finished', finishedMs, { sessionId: SESSION, turnId: 1, seq: 4, ...finishedArgs }),
    span('prompt.turn', 0, finishedMs, { seq: 4, ...rootArgs }),
    span('prompt.e2e', 0, finishedMs, { seq: 4, ...rootArgs }),
    ...extra,
  ].filter(event => !omit.includes(event.name))
  return { traceEvents: events, displayTimeUnit: 'ms', dropped }
}

function serverBatch({ traceId = hex(1), pid = 4242, dropped = 0, events } = {}) {
  return {
    traceEvents: events ?? [
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000, dur: 1500, pid: `server:${pid}`, tid: 1, args: { traceId, sessionId: SESSION, turnId: 1 } },
      { name: 'model.stream', cat: 'fx0', ph: 'X', ts: 9_000_100, dur: 800, pid: `server:${pid}`, tid: 1, args: { traceId, sessionId: SESSION, turnId: 1 } },
    ],
    displayTimeUnit: 'ms',
    dropped,
  }
}

function makeRun({ n = 1, label = 'baseline', pairId = null, firstTextMs = 5, revision = 'abc1234', sourceHash = hash('4'),
  meta = {}, rootArgs = {}, server, omit = [], extra = [], dropped = 0 } = {}) {
  const traceId = hex(n)
  return createRun({
    browser: browserCapture({ traceId, firstTextMs, rootArgs, omit, extra, dropped }),
    server: server === undefined ? serverBatch({ traceId }) : server,
    metadata: metadata({ revision, sourceHash, ...meta }),
    label, pairId, recordedAt: RECORDED_AT,
  })
}

test('a complete capture uses browser-clock metrics and joins only server events with the root traceId', () => {
  const traceId = hex(1)
  const other = hex(2)
  const run = makeRun({
    n: 1,
    server: serverBatch({ traceId, events: [
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000, dur: 1500, pid: 'server:4242', tid: 1, args: { traceId, sessionId: SESSION, turnId: 1 } },
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_100_000, dur: 1500, pid: 'server:4242', tid: 1, args: { traceId: other, sessionId: SESSION, turnId: 2 } },
    ] }),
  })
  assert.equal(run.id, traceId)
  assert.equal(run.status, 'complete')
  assert.deepEqual(run.issues, ['server_unmatched'], 'an unrelated turn in the batch is counted, not joined')
  assert.deepEqual(run.metrics, { sendingMs: 2, firstTextMs: 5, firstDraftMs: null, finishedMs: 100, previewMs: null })
  const serverEvents = run.trace.traceEvents.filter(event => event.pid.startsWith('server:'))
  assert.equal(serverEvents.length, 1)
  assert.equal(serverEvents[0].args.traceId, traceId)
  assert.equal(run.trace.dropped, 0)
})

test('server events that share only a session are never assigned to the run', () => {
  const run = makeRun({ n: 1, server: serverBatch({ traceId: hex(9) }) })
  assert.equal(run.trace.traceEvents.filter(event => event.pid.startsWith('server:')).length, 0)
  assert.deepEqual(run.issues, ['server_missing', 'server_unmatched'])
  assert.equal(run.status, 'complete', 'browser coverage stays complete; missing server coverage is reported, not hidden')
})

test('missing server coverage is an issue that leaves a complete browser run complete', () => {
  const run = makeRun({ n: 1, server: null })
  assert.equal(run.status, 'complete')
  assert.deepEqual(run.issues, ['server_missing'])
  assert.equal(run.metrics.finishedMs, 100)
})

test('a failed or cancelled root is failed with no latency numbers', () => {
  for (const [flag, issue] of [['failed', 'prompt_failed'], ['cancelled', 'prompt_cancelled']]) {
    const run = makeRun({ n: 1, rootArgs: { [flag]: true } })
    assert.equal(run.status, 'failed')
    assert.ok(run.issues.includes(issue))
    assert.deepEqual(Object.values(run.metrics), [null, null, null, null, null], 'a failed run never reports a latency')
    assert.ok(run.trace.traceEvents.length > 0, 'the failed evidence is preserved')
  }
})

test('an incomplete journal completion stays incomplete, not successful', () => {
  const run = makeRun({ n: 1, rootArgs: { incomplete: true } })
  assert.equal(run.status, 'incomplete')
  assert.ok(run.issues.includes('prompt_incomplete'))
  assert.deepEqual(Object.values(run.metrics), [null, null, null, null, null])
})

test('dropped events make a run incomplete and keep the drop counts', () => {
  const run = makeRun({ n: 1, dropped: 3, server: serverBatch({ traceId: hex(1), dropped: 2 }) })
  assert.equal(run.status, 'incomplete')
  assert.ok(run.issues.includes('dropped_browser'))
  assert.ok(run.issues.includes('dropped_server'))
  assert.equal(run.trace.dropped, 5)
  assert.deepEqual(Object.values(run.metrics), [null, null, null, null, null], 'drops never become a measurement')
})

test('a missing finish or root is incomplete with a fixed code, not a fabricated zero', () => {
  const noFinish = makeRun({ n: 1, omit: ['prompt.finished'] })
  assert.equal(noFinish.status, 'incomplete')
  assert.ok(noFinish.issues.includes('browser_inconsistent'))
  assert.deepEqual(Object.values(noFinish.metrics), [null, null, null, null, null])

  const noRoot = makeRun({ n: 1, omit: ['prompt.e2e', 'prompt.turn'] })
  assert.equal(noRoot.status, 'incomplete')
  assert.ok(noRoot.issues.includes('browser_root_missing'))
})

test('malformed run metadata throws naming the field, and never echoes the rejected value', () => {
  const cases = [
    [{ workload: 'https://example.test/x?token=PRIVATE_TOKEN' }, 'workload'],
    [{ workload: '<img src=x onerror=alert(1)>' }, 'workload'],
    [{ model: 'https://example.test/PRIVATE_TOKEN' }, 'model'],
    [{ revision: '../../PRIVATE_PATH' }, 'revision'],
    [{ viewport: { width: '1280', height: 800, dpr: 2 } }, 'viewport'],
    [{ instrumentation: 'other-trace' }, 'instrumentation'],
    [{ prompt: 'PRIVATE_PROMPT' }, 'exactly the fixed fields'],
  ]
  for (const [overrides, expected] of cases) {
    const meta = metadata(overrides)
    assert.throws(() => createRun({ browser: browserCapture(), metadata: meta, recordedAt: RECORDED_AT }), error => {
      assert.ok(error instanceof TypeError)
      assert.doesNotMatch(error.message, /PRIVATE|https|<img|alert/)
      assert.match(error.message, new RegExp(expected))
      return true
    })
  }
})

test('malformed containers, timestamps, and labels throw instead of producing a clean run', () => {
  const two = browserCapture()
  two.traceEvents.push({ ...two.traceEvents[0], args: { traceId: hex(7) } })
  assert.throws(() => createRun({ browser: two, metadata: metadata(), recordedAt: RECORDED_AT }), /more than one prompt/)
  assert.throws(() => createRun({ browser: null, metadata: metadata(), recordedAt: RECORDED_AT }), TypeError)
  assert.throws(() => createRun({ browser: { ...browserCapture(), dropped: -1 }, metadata: metadata(), recordedAt: RECORDED_AT }), /drop count/)
  assert.throws(() => createRun({ browser: browserCapture(), metadata: metadata(), recordedAt: 'yesterday' }), /recordedAt/)
  assert.throws(() => createRun({ browser: browserCapture(), metadata: metadata(), label: 'Baseline', recordedAt: RECORDED_AT }), /label/)
  assert.throws(() => createRun({ browser: browserCapture(), metadata: metadata(), pairId: 'a b', recordedAt: RECORDED_AT }), /pairId/)
  assert.throws(() => createRun({ browser: browserCapture(), metadata: { ...metadata(), extra: 1 }, recordedAt: RECORDED_AT }), /exactly the fixed fields/)
})

test('arbitrary strings, URLs, and foreign lanes never reach the stored trace or the Chrome export', () => {
  const leaking = {
    name: 'prompt.finished', cat: 'fx0', ph: 'i', ts: ORIGIN_US + 1000, pid: 'browser', tid: 1,
    args: { traceId: hex(1), sessionId: SESSION, turnId: 1, seq: 4, prompt: 'PRIVATE_PROMPT', url: 'https://example.test/?t=PRIVATE_TOKEN', html: '<img src=x onerror=alert(1)>' },
  }
  const run = makeRun({
    n: 1,
    extra: [leaking, { name: 'prompt.leak', cat: 'fx0', ph: 'i', ts: ORIGIN_US, pid: 'browser', tid: 1, args: { traceId: hex(1), secret: 'PRIVATE_SECRET' } }],
    server: { traceEvents: [
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000, dur: 1, pid: '/Users/PRIVATE_HOME', tid: 1, args: { traceId: hex(1) } },
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000, dur: 1, pid: 'server:../PRIVATE', tid: 1, args: { traceId: hex(1) } },
    ], displayTimeUnit: 'ms', dropped: 0 },
  })
  assert.ok(run.issues.includes('event_rejected'))
  const stored = JSON.stringify(run)
  const exported = JSON.stringify(exportChromeTrace(run))
  for (const text of [stored, exported]) {
    assert.doesNotMatch(text, /PRIVATE|https:|<img|alert\(|\/Users\//)
  }
  for (const event of run.trace.traceEvents) {
    for (const key of Object.keys(event.args)) assert.ok(ALLOWED_ARGS.has(key), `unexpected arg ${key}`)
  }
})

test('compareRuns reports paired medians, paired deltas, and improvement from complete pairs', () => {
  const baselines = [10, 20, 30, 40, 50].map((ms, index) => makeRun({ n: index + 1, label: 'baseline', pairId: String(index + 1), firstTextMs: ms }))
  const candidates = [8, 16, 24, 32, 40].map((ms, index) => makeRun({ n: index + 11, label: 'candidate', pairId: String(index + 1), firstTextMs: ms, revision: 'def5678', sourceHash: hash('5') }))
  const result = compareRuns(baselines, candidates)
  assert.equal(result.compatible, true, result.reasons.join(','))
  assert.deepEqual(result.reasons, [])
  assert.equal(result.control, false, 'different source hashes are a real comparison')
  assert.equal(result.smallSample, false)
  assert.deepEqual(result.counts, { baseline: 5, candidate: 5, paired: 5, valid: 5, failed: 0, unpaired: 0 })
  assert.deepEqual(result.pairs[0], { pairId: '1', baselineId: hex(1), candidateId: hex(11), status: 'valid' })
  const row = result.metrics.find(metric => metric.name === 'firstTextMs')
  assert.deepEqual(row.baseline, { n: 5, p50: 30, p95: 50 })
  assert.deepEqual(row.candidate, { n: 5, p50: 24, p95: 40 })
  assert.equal(row.pairedDeltaMs, -6, 'median of candidate minus baseline per pair')
  assert.equal(row.improvementPercent, 20, 'positive means the candidate was quicker, relative to the baseline paired median')
})

test('a candidate that is slower gets a negative improvement and a positive delta', () => {
  const baselines = [5, 5, 5, 5, 5].map((ms, index) => makeRun({ n: index + 1, pairId: String(index + 1), firstTextMs: ms }))
  const candidates = [10, 10, 10, 10, 10].map((ms, index) => makeRun({ n: index + 11, label: 'candidate', pairId: String(index + 1), firstTextMs: ms, revision: 'def5678', sourceHash: hash('5') }))
  const row = compareRuns(baselines, candidates).metrics.find(metric => metric.name === 'firstTextMs')
  assert.equal(row.pairedDeltaMs, 5)
  assert.equal(row.improvementPercent, -100)
})

test('a zero baseline yields a null improvement instead of an infinite one', () => {
  const baselines = [0, 0, 0, 0, 0].map((ms, index) => makeRun({ n: index + 1, pairId: String(index + 1), firstTextMs: ms }))
  const candidates = [3, 3, 3, 3, 3].map((ms, index) => makeRun({ n: index + 11, label: 'candidate', pairId: String(index + 1), firstTextMs: ms, revision: 'def5678', sourceHash: hash('5') }))
  const row = compareRuns(baselines, candidates).metrics.find(metric => metric.name === 'firstTextMs')
  assert.equal(row.pairedDeltaMs, 3)
  assert.equal(row.improvementPercent, null)
})

test('a failed, unpaired, and pairless run is counted and never silently discarded', () => {
  const baselines = [1, 2, 3, 4, 5, 6].map((n, index) => makeRun({ n, pairId: String(index + 1), firstTextMs: 10 }))
  const candidates = [1, 2, 3, 4, 5].map((n, index) => makeRun({
    n: n + 10, label: 'candidate', pairId: String(index + 1), firstTextMs: 8, revision: 'def5678', sourceHash: hash('5'),
    rootArgs: index === 4 ? { failed: true } : {},
  }))
  candidates.push(makeRun({ n: 30, label: 'candidate', pairId: null, firstTextMs: 8, revision: 'def5678', sourceHash: hash('5') }))
  const result = compareRuns(baselines, candidates)
  assert.equal(result.compatible, true, result.reasons.join(','))
  assert.deepEqual(result.counts, { baseline: 6, candidate: 6, paired: 5, valid: 4, failed: 1, unpaired: 2 })
  assert.deepEqual(result.pairs.find(pair => pair.pairId === '5'), { pairId: '5', baselineId: hex(5), candidateId: hex(15), status: 'failed' })
  assert.deepEqual(result.pairs.find(pair => pair.pairId === '6'), { pairId: '6', baselineId: hex(6), candidateId: null, status: 'unpaired' })
  assert.ok(result.pairs.some(pair => pair.pairId === null && pair.candidateId === hex(30) && pair.status === 'unpaired'))
  assert.equal(result.smallSample, true, 'four valid pairs is a descriptive small sample')
  const row = result.metrics.find(metric => metric.name === 'firstTextMs')
  assert.equal(row.pairedDeltaMs, -2, 'the failed pair contributes no delta')
  assert.equal(row.candidate.n, 5, 'only complete candidate runs are aggregated')
})

test('a different model, environment, or unknown setting refuses comparison and reports no metrics', () => {
  const baselines = [1, 2, 3, 4, 5].map((n, index) => makeRun({ n, pairId: String(index + 1), firstTextMs: 10 }))
  const modelChanged = [11, 12, 13, 14, 15].map((n, index) => makeRun({
    n, label: 'candidate', pairId: String(index + 1), firstTextMs: 8, revision: 'def5678', sourceHash: hash('5'), meta: { model: 'openai/gpt-5.2' },
  }))
  const changed = compareRuns(baselines, modelChanged)
  assert.equal(changed.compatible, false)
  assert.deepEqual(changed.reasons, ['model_mismatch'])
  assert.deepEqual(changed.metrics, [])
  assert.equal(changed.counts.valid, 5, 'the pairs are still reported for inspection')

  const unknownEnv = [11, 12, 13, 14, 15].map((n, index) => makeRun({
    n, label: 'candidate', pairId: String(index + 1), firstTextMs: 8, revision: 'def5678', sourceHash: hash('5'), meta: { environment: 'unknown' },
  }))
  assert.ok(compareRuns(baselines, unknownEnv).reasons.includes('environment_unknown'))

  const noViewport = [11, 12, 13, 14, 15].map((n, index) => makeRun({
    n, label: 'candidate', pairId: String(index + 1), firstTextMs: 8, revision: 'def5678', sourceHash: hash('5'), meta: { viewport: null },
  }))
  assert.ok(compareRuns(baselines, noViewport).reasons.includes('viewport_unknown'))
  assert.equal(compareRuns(baselines, noViewport).metrics.length, 0)
})

test('the same source hash on both sides is an A/A control, not an improvement', () => {
  const baselines = [1, 2, 3, 4, 5].map((n, index) => makeRun({ n, pairId: String(index + 1), firstTextMs: 10 }))
  const candidates = [11, 12, 13, 14, 15].map((n, index) => makeRun({ n, label: 'candidate', pairId: String(index + 1), firstTextMs: 10 + (index % 2) }))
  const result = compareRuns(baselines, candidates)
  assert.equal(result.compatible, true)
  assert.equal(result.control, true)
  assert.ok(result.metrics.length > 0)
})

test('duplicate pairIds and reused run ids are rejected', () => {
  const first = makeRun({ n: 1, pairId: '1' })
  const second = makeRun({ n: 2, pairId: '1' })
  assert.throws(() => compareRuns([first, second], [makeRun({ n: 3, label: 'candidate', pairId: '1' })]), /Duplicate pairId/)
  assert.throws(() => compareRuns([first], [makeRun({ n: 1, label: 'candidate', pairId: '1' })]), /reused/)
  assert.throws(() => compareRuns([{ version: 2 }], [first]), /Invalid performance run/)
})

test('fewer than five valid pairs is labeled as a small sample and claims no significance', () => {
  const baselines = [10, 12, 14].map((ms, index) => makeRun({ n: index + 1, pairId: String(index + 1), firstTextMs: ms }))
  const candidates = [9, 11, 13].map((ms, index) => makeRun({ n: index + 11, label: 'candidate', pairId: String(index + 1), firstTextMs: ms, revision: 'def5678', sourceHash: hash('5') }))
  const result = compareRuns(baselines, candidates)
  assert.equal(result.smallSample, true)
  assert.equal(result.metrics.length, 5)
  assert.equal(Object.hasOwn(result, 'pValue'), false)
  assert.equal(Object.hasOwn(result, 'significant'), false)
})

test('a run that has been stored and reloaded still compares, and a run with stale metrics is refused', () => {
  const baselines = [1, 2, 3, 4, 5].map((n, index) => makeRun({ n, pairId: String(index + 1), firstTextMs: 10 }))
  const reloaded = JSON.parse(JSON.stringify(baselines))
  const candidates = [11, 12, 13, 14, 15].map((n, index) => makeRun({ n, label: 'candidate', pairId: String(index + 1), firstTextMs: 8, revision: 'def5678', sourceHash: hash('5') }))
  assert.equal(compareRuns(reloaded, candidates).counts.valid, 5)
  const stale = JSON.parse(JSON.stringify(baselines[0]))
  stale.status = 'failed'
  assert.throws(() => compareRuns([stale], candidates), /reports metrics/)
})

test('makeSchedule is balanced, bounded, seeded, and reproducible', () => {
  for (const pairs of [1, 2, 7, 20, 100]) {
    const schedule = makeSchedule(pairs, 'fx0-seed')
    assert.equal(schedule.length, pairs)
    assert.deepEqual(schedule.map(entry => entry.pairId), Array.from({ length: pairs }, (_, index) => String(index + 1)))
    const ab = schedule.filter(entry => entry.order[0] === 'baseline').length
    assert.ok(Math.abs(ab - (pairs - ab)) <= 1, `AB ${ab} vs BA ${pairs - ab}`)
    for (const entry of schedule) assert.ok(JSON.stringify(entry.order) === '["baseline","candidate"]' || JSON.stringify(entry.order) === '["candidate","baseline"]')
  }
  assert.deepEqual(makeSchedule(8, 'fx0-seed'), makeSchedule(8, 'fx0-seed'))
  assert.notDeepEqual(makeSchedule(20, 'alpha'), makeSchedule(20, 'beta'))
  assert.deepEqual(makeSchedule(4, 42), makeSchedule(4, '42'))
  for (const pairs of [0, 101, 1.5, '3', -1, null]) assert.throws(() => makeSchedule(pairs, 'x'), /pairs must be an integer from 1 to 100/)
  assert.throws(() => makeSchedule(4), /seed/)
  assert.throws(() => makeSchedule(4, 'has spaces'), /seed/)
})

test('exportChromeTrace names lanes Browser and ServerN with numeric pids and numeric fields only', () => {
  const run = makeRun({
    n: 1,
    server: {
      traceEvents: [
        { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000, dur: 1500, pid: 'server:4242', tid: 1, args: { traceId: hex(1) } },
        { name: 'model.stream', cat: 'fx0', ph: 'X', ts: 9_000_100, dur: 800, pid: 'server:0f0e0d0c-0b0a-4000-8000-000000000001', tid: 1, args: { traceId: hex(1) } },
      ],
      displayTimeUnit: 'ms',
      dropped: 0,
    },
  })
  const exported = exportChromeTrace(run)
  assert.equal(exported.displayTimeUnit, 'ms')
  const names = exported.traceEvents.filter(event => event.ph === 'M').map(event => [event.pid, event.args.name])
  assert.deepEqual(names, [[2, 'Server1'], [3, 'Server2'], [1, 'Browser']].sort((a, b) => a[0] - b[0]))
  for (const event of exported.traceEvents) {
    assert.equal(typeof event.pid, 'number')
    assert.equal(typeof event.tid, 'number')
    assert.equal(typeof event.ts, 'number')
    assert.ok(Number.isFinite(event.ts))
    if (event.ph === 'X') assert.ok(Number.isFinite(event.dur) && event.dur >= 0)
    if (event.ph !== 'M') for (const key of Object.keys(event.args)) assert.ok(ALLOWED_ARGS.has(key))
  }
  assert.deepEqual(exportChromeTrace(run), exported, 'the same run exports the same lanes')
  assert.doesNotMatch(JSON.stringify(exported), /\/Users|PRIVATE/)
  assert.throws(() => exportChromeTrace({ version: 1 }), TypeError)
})
