import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sanitizeTraceSnapshot } from '../lib/performance-trace.ts'

const usage = 'Usage: node scripts/trace-report.mjs [--json] <server-directory-or-file> [browser.json]'

async function inputFiles(inputs) {
  const files = []
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      for (const name of (await readdir(input)).sort()) {
        if (/^server-\d+\.jsonl$/.test(name)) files.push(path.join(input, name))
      }
    } else files.push(input)
  }
  return files
}

// A .json file may hold one record, an array, or Vercel's one-record-per-line export.
function parseRecords(file, text) {
  const lines = () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (file.endsWith('.jsonl')) return lines()
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : [value]
  } catch {
    return lines()
  }
}

// Reads browser JSON, server JSONL, and Vercel log exports. Every accepted batch goes through the
// shared trace sanitizer, so only fixed names, lanes, identifiers, and numeric fields are returned.
export async function loadTraceFiles(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('loadTraceFiles expects an array of paths')
  const files = await inputFiles(inputs)
  const traceEvents = []
  let dropped = 0
  // Only Vercel wrappers duplicate exported messages. Native batches remain
  // distinct observations, even if coarse timestamps make their events identical.
  const seenBatches = new Set()
  const addBatch = (batch, fromLog = false) => {
    const clean = sanitizeTraceSnapshot(batch)
    if (fromLog) {
      const key = JSON.stringify({ traceEvents: clean.traceEvents, dropped: clean.dropped })
      if (seenBatches.has(key)) return
      seenBatches.add(key)
    }
    for (const event of clean.traceEvents) traceEvents.push(event)
    dropped += clean.dropped
  }
  for (const file of files) {
    for (const record of parseRecords(file, await readFile(file, 'utf8'))) {
      if (!record || typeof record !== 'object') continue
      if (Array.isArray(record.traceEvents)) {
        addBatch(record)
        continue
      }
      // Vercel logs repeat a request's first message in its nested logs. Only
      // our fixed JSON event is consumed, and repeated exported batches are deduplicated.
      const logs = Array.isArray(record.logs) ? record.logs : []
      for (const message of [record.message, ...logs.map(log => log?.message)]) {
        let batch
        try { batch = JSON.parse(message) } catch { continue }
        if (batch?.event !== 'fx0:trace' || !Array.isArray(batch.traceEvents)) continue
        addBatch(batch, true)
      }
    }
  }
  return { files, traceEvents, dropped }
}

function printReport(traceEvents, dropped) {
  const durations = new Map()
  const instants = new Map()
  for (const event of traceEvents) {
    if (event.ph === 'X' && Number.isFinite(event.dur)) {
      if (!durations.has(event.name)) durations.set(event.name, [])
      durations.get(event.name).push(event.dur / 1000)
    } else instants.set(event.name, (instants.get(event.name) ?? 0) + 1)
  }
  const rows = []
  for (const [name, values] of durations) {
    values.sort((a, b) => a - b)
    const percentile = p => values[Math.max(0, Math.ceil(values.length * p) - 1)].toFixed(3)
    rows.push({ span: name, count: values.length, 'p50 ms': percentile(0.5), 'p95 ms': percentile(0.95), 'max ms': values.at(-1).toFixed(3) })
  }
  console.table(rows.sort((a, b) => a.span.localeCompare(b.span)))
  if (instants.size) console.table([...instants].map(([event, count]) => ({ event, count })))
  const milestones = []
  for (const start of traceEvents.filter(event => event.pid === 'browser' && event.name === 'prompt.started' && event.ph === 'i')) {
    // Browser events only: server timestamps are on another clock and are never subtracted here.
    const events = traceEvents.filter(event => event.pid === 'browser' && event.args?.traceId === start.args?.traceId)
    const relative = name => {
      const event = events.find(event => event.name === name && event.ph === 'i')
      return event ? ((event.ts - start.ts) / 1000).toFixed(3) : null
    }
    milestones.push({ traceId: start.args?.traceId, 'accepted ms': relative('prompt.acknowledged'),
      'first text received ms': relative('prompt.first_content'), 'first HTML received ms': relative('prompt.first_draft'),
      'turn finished ms': relative('prompt.finished') })
  }
  if (milestones.length) console.table(milestones)
  console.log(`Events: ${traceEvents.length}. Dropped from full buffers: ${dropped}. Durations overlap; do not sum spans.`)
  console.log('Browser milestones start at the accepted send handler. They are not text-paint timings; server/browser clocks must not be subtracted to infer network latency.')
}

async function main(argv) {
  const json = argv.includes('--json')
  const inputs = argv.filter(arg => arg !== '--json')
  const { files, traceEvents, dropped } = inputs.length ? await loadTraceFiles(inputs) : { files: [], traceEvents: [], dropped: 0 }
  if (!files.length) {
    console.error(usage)
    process.exitCode = 1
    return
  }
  if (!traceEvents.length) throw new Error('No completed fx0 trace events found; an empty log is not a measurement')
  if (json) console.log(JSON.stringify({ traceEvents, displayTimeUnit: 'ms', dropped }))
  else printReport(traceEvents, dropped)
}

// Importing this module (for loadTraceFiles) must not read arguments or print a report.
const isEntrypoint = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isEntrypoint) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
