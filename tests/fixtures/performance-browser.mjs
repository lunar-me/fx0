import { beginBrowserPrompt, traceBrowser } from '/lib/trace-browser.ts'
import { compactTranscript } from '/lib/transcript.ts'
import { createEventDelivery } from '/lib/event-delivery.ts'
import { applyDesignDraft, EMPTY_DRAFT } from '/lib/design-draft.ts'
import { patchDraftDocument } from '/lib/draft-preview.ts'
import { applyStreamItem, groupThreadEntries } from '/components/chat-state.ts'

const sessionId = '00000000-0000-4000-8000-000000000001'
const samples = 30
const warmups = 5
const frameBudgetMs = 1000 / 60
const phases = ['event.parse', 'event.apply', 'thread.group', 'draft.sanitize', 'draft.patch']

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1]
  return { count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) }
}

function history(turns) {
  const events = []
  const add = event => events.push({ ...event, seq: events.length + 1, at: events.length })
  for (let id = 1; id <= turns; id++) {
    add({ type: 'user', id, text: 'Synthetic request', author: 'Benchmark' })
    add({ type: 'turn_start', id, turnId: id })
    add({ type: 'reasoning', turnId: id, delta: 'Synthetic reasoning' })
    add({ type: 'tool_start', turnId: id, name: 'publish_design', callId: id })
    add({ type: 'tool_end', turnId: id, name: 'publish_design', callId: id })
    add({ type: 'text', turnId: id, delta: 'Synthetic response' })
    add({ type: 'artifact', turnId: id, artifactRevision: id })
    add({ type: 'done', id, turnId: id })
  }
  return events
}

function row(id) {
  return `<section id="row-${id}"><h2>Benchmark card ${id}</h2><p>Repeated synthetic content representing a generated page.</p><button>Continue</button></section>`
}

function runScenario(inputKiB, historyTurns, traceEnabled) {
  globalThis.__fx0PerfTrace = traceEnabled ? '1' : '0'
  window.__fx0Trace?.clear()
  const traceId = beginBrowserPrompt(sessionId)
  const turnId = historyTurns + 1
  const context = { traceId, sessionId, turnId }
  const seed = history(historyTurns)
  let seq = seed.length
  const view = { artifactRevision: historyTurns }
  let snapshot = compactTranscript(seed, view)
  let entries = snapshot.entries
  const delivery = createEventDelivery(seq, historyTurns)
  let draft = EMPTY_DRAFT
  const target = document.implementation.createHTMLDocument('benchmark')
  let html = '<!doctype html><html><head><style>body{color:#222}section{padding:16px}</style></head><body>'
  let rows = 0
  while (html.length < inputKiB * 1024) html += row(rows++)
  const startingBytes = html.length // Workload uses ASCII only.
  const values = Object.fromEntries(phases.map(name => [name, []]))
  const totals = []
  let current
  const timed = (name, work) => {
    const start = performance.now()
    try { return work() } finally { current[name] += performance.now() - start }
  }
  const patchTrace = (name, ctx, attrs) => {
    const started = performance.now()
    const end = traceBrowser(name, ctx, attrs)
    return result => { end(result); current[name] += performance.now() - started }
  }
  const apply = item => {
    for (const ready of delivery.push(item)) {
      if (ready.type === 'design_draft') draft = applyDesignDraft(draft, ready, historyTurns)
      else {
        // Mirror ChatApp's checkpoint and visible-entry reducers, not a benchmark-only reducer.
        snapshot = compactTranscript([ready], view, snapshot)
        entries = applyStreamItem(entries, ready)
      }
    }
  }
  // Initialize the running turn outside the measured window.
  apply({ type: 'user', seq: ++seq, id: turnId, text: 'Synthetic update', author: 'Benchmark' })
  apply({ type: 'turn_start', seq: ++seq, id: turnId, turnId })
  let lastRows = []
  for (let index = 0; index < warmups + samples; index++) {
    if (index === warmups) window.__fx0Trace?.clear()
    const delta = index === 0 ? html : row(rows++)
    const offset = index === 0 ? 0 : html.length
    if (index > 0) html += delta
    // Encoding is the server's job. Only browser JSON parsing and downstream work are timed.
    const wire = [JSON.stringify({ type: 'text', seq: ++seq, turnId, delta: 'more synthetic text ' }),
      JSON.stringify({ type: 'design_draft', draftId: 'benchmark-draft', draftRevision: 1,
        turnId, artifactRevision: historyTurns, draftOffset: offset, delta })]
    current = Object.fromEntries(phases.map(name => [name, 0]))
    const started = performance.now()
    const items = timed('event.parse', () => wire.map(text => JSON.parse(text)))
    timed('event.apply', () => {
      const end = traceBrowser('event.apply', context, { count: items.length })
      try { for (const item of items) apply(item) } finally { end() }
    })
    lastRows = timed('thread.group', () => groupThreadEntries(entries, turnId))
    patchDraftDocument(target, draft.draft.html, context, patchTrace)
    const elapsed = performance.now() - started
    if (index >= warmups) {
      totals.push(elapsed)
      for (const name of phases) values[name].push(current[name])
    }
  }
  const capture = traceEnabled ? window.__fx0Trace.snapshot() : { traceEvents: [], dropped: 0 }
  const checkpointMatches = JSON.stringify(entries) === JSON.stringify(snapshot.entries)
  const result = {
    inputKiB, historyTurns, traceEnabled, samples, warmups, startingBytes, endingBytes: html.length,
    historyEvents: seed.length, historyEntries: compactTranscript(seed, view).entries.length,
    nodes: target.querySelectorAll('*').length, cpu: stats(totals),
    overFrameBudget: totals.filter(value => value > frameBudgetMs).length,
    phases: phases.map(name => ({ name, ...stats(values[name]) })),
    valid: checkpointMatches && draft.draft.html === html && delivery.cursor === seq &&
      lastRows.length > historyTurns && target.querySelectorAll('section').length === rows &&
      !target.querySelector('script'),
    capture,
  }
  target.documentElement.replaceChildren()
  return result
}

export function runBenchmark() {
  const scenarios = []
  let order = 0
  for (const inputKiB of [32, 128, 384]) for (const historyTurns of [10, 200]) {
    // Alternate order to reduce a systematic tracing-on/second-run bias.
    for (const tracing of order++ % 2 ? [true, false] : [false, true]) {
      scenarios.push(runScenario(inputKiB, historyTurns, tracing))
    }
  }
  return { schema: 1, userAgent: navigator.userAgent, frameBudgetMs,
    scope: 'Synchronous browser CPU replay on detached documents; excludes React commits, layout, paint, network, model, and databases.',
    scenarios }
}
