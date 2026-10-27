import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const script = fileURLToPath(new URL('../scripts/trace-report.mjs', import.meta.url))
const run = promisify(execFile)
const traceId = 'a'.repeat(32)

// Synthetic fixture events in the fixed trace format. Timestamps are microseconds.
const browserEvents = [
  { name: 'prompt.started', cat: 'fx0', ph: 'i', s: 't', ts: 1_000_000, pid: 'browser', tid: 1, args: { traceId } },
  { name: 'prompt.acknowledged', cat: 'fx0', ph: 'i', s: 't', ts: 1_250_000, pid: 'browser', tid: 1, args: { traceId } },
  { name: 'prompt.first_content', cat: 'fx0', ph: 'i', s: 't', ts: 1_500_000, pid: 'browser', tid: 1, args: { traceId } },
  { name: 'prompt.first_draft', cat: 'fx0', ph: 'i', s: 't', ts: 2_000_000, pid: 'browser', tid: 1, args: { traceId } },
  { name: 'prompt.finished', cat: 'fx0', ph: 'i', s: 't', ts: 3_000_000, pid: 'browser', tid: 1, args: { traceId, seq: 8 } },
  { name: 'prompt.e2e', cat: 'fx0', ph: 'X', ts: 1_000_000, dur: 2_000_000, pid: 'browser', tid: 1, args: { traceId } },
]
// Server lane with a deliberately skewed clock: its acknowledged instant must never move the browser table.
const serverEvents = [
  { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000_000, dur: 4_000, pid: 'server:4242', tid: 1, args: { traceId, secret: 'PRIVATE_PROMPT_TEXT' } },
  { name: 'prompt.acknowledged', cat: 'fx0', ph: 'i', s: 't', ts: 5, pid: 'server:4242', tid: 1, args: { traceId } },
]
const laterServerBatch = [
  { name: 'model.stream', cat: 'fx0', ph: 'X', ts: 9_000_010_000, dur: 8_000, pid: 'server:4242', tid: 1, args: {} },
]

async function fixtureDirectory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fx0-trace-report-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// Parses console.table output into a column-keyed object for the milestone row.
function milestoneRow(stdout) {
  const rows = stdout.split('\n').filter(line => line.startsWith('│'))
    .map(line => line.split('│').slice(1, -1).map(cell => cell.trim().replace(/^'(.*)'$/, '$1')))
  const headerIndex = rows.findIndex(cells => cells.includes('accepted ms'))
  assert.notEqual(headerIndex, -1, 'milestone table is printed')
  return Object.fromEntries(rows[headerIndex].map((name, index) => [name, rows[headerIndex + 1][index]]))
}

test('native browser JSON and server JSONL: spans, dropped count, and browser-only milestones', async t => {
  const dir = await fixtureDirectory(t)
  await writeFile(path.join(dir, 'browser.json'), JSON.stringify({ traceEvents: browserEvents, displayTimeUnit: 'ms', dropped: 0 }))
  await writeFile(path.join(dir, 'server-4242.jsonl'), JSON.stringify({ traceEvents: serverEvents, displayTimeUnit: 'ms', dropped: 3 }) + '\n')
  // Not a server-<pid>.jsonl name: the directory scan must not read it.
  await writeFile(path.join(dir, 'notes.jsonl'), 'not a trace record\n')
  const { stdout } = await run(process.execPath, [script, dir, path.join(dir, 'browser.json')], { timeout: 10000 })
  assert.match(stdout, /request\.handle/)
  assert.match(stdout, /Dropped from full buffers: 3\./)
  assert.match(stdout, /Browser milestones start at the accepted send handler/)
  assert.doesNotMatch(stdout, /PRIVATE_PROMPT_TEXT/, 'span args are not printed in the table')
  const row = milestoneRow(stdout)
  assert.equal(row['accepted ms'], '250.000')
  assert.equal(row['first text received ms'], '500.000')
  assert.equal(row['first HTML received ms'], '1000.000')
  assert.equal(row['turn finished ms'], '2000.000')
})

test('Vercel wrapped logs: only the fixed fx0:trace tag counts, and repeated head/nested messages count once', async t => {
  const dir = await fixtureDirectory(t)
  const batch = JSON.stringify({ event: 'fx0:trace', traceEvents: serverEvents.slice(0, 1), displayTimeUnit: 'ms', dropped: 1 })
  const second = JSON.stringify({ event: 'fx0:trace', traceEvents: laterServerBatch, displayTimeUnit: 'ms', dropped: 0 })
  const lines = [
    { message: batch, logs: [{ message: batch }] },
    { message: batch, logs: [] },
    { message: second, logs: [{ message: 'plain text' }] },
    { message: JSON.stringify({ event: 'other', traceEvents: [{ name: 'request.handle', ph: 'X', ts: 1, dur: 999 }] }) },
    { message: JSON.stringify({ event: 'fx0:trace', traceEvents: 'not-an-array' }), logs: [{}] },
  ]
  const file = path.join(dir, 'vercel-logs.json')
  await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  const { stdout } = await run(process.execPath, [script, file], { timeout: 10000 })
  assert.match(stdout, /Dropped from full buffers: 1\./)
  assert.match(stdout, /model\.stream/)
  assert.doesNotMatch(stdout, /999/, 'the untagged batch never reaches the report')
})

test('an empty or untagged log fails with a clean message, not a measurement', async t => {
  const dir = await fixtureDirectory(t)
  const file = path.join(dir, 'empty-logs.json')
  await writeFile(file, JSON.stringify({ message: 'just an application log line', logs: [] }) + '\n')
  await assert.rejects(run(process.execPath, [script, file], { timeout: 10000 }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /No completed fx0 trace events found; an empty log is not a measurement/)
    assert.doesNotMatch(error.stderr, /\n\s+at /, 'no stack trace')
    return true
  })
  await assert.rejects(run(process.execPath, [script], { timeout: 10000 }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Usage: node scripts\/trace-report\.mjs/)
    return true
  })
})

test('--json preserves identical native batches and deduplicates only repeated log batches', async t => {
  const dir = await fixtureDirectory(t)
  const copied = JSON.stringify({ traceEvents: serverEvents, displayTimeUnit: 'ms', dropped: 2 })
  // Native observations are preserved even when their serialized events match.
  await writeFile(path.join(dir, 'server-4242.jsonl'), copied + '\n')
  await writeFile(path.join(dir, 'server-4343.jsonl'), copied + '\n' + JSON.stringify({ traceEvents: laterServerBatch, displayTimeUnit: 'ms', dropped: 0 }) + '\n')
  const vercel = path.join(dir, 'vercel.json')
  const message = JSON.stringify({ event: 'fx0:trace', traceEvents: serverEvents, displayTimeUnit: 'ms', dropped: 2 })
  await writeFile(vercel, JSON.stringify({ message, logs: [{ message }] }) + '\n')
  const browserFile = path.join(dir, 'browser.json')
  await writeFile(browserFile, JSON.stringify({ traceEvents: browserEvents, displayTimeUnit: 'ms', dropped: 0 }))
  const { stdout } = await run(process.execPath, [script, '--json', dir, browserFile, vercel], { timeout: 10000 })
  const exported = JSON.parse(stdout)
  assert.equal(exported.displayTimeUnit, 'ms')
  assert.equal(exported.dropped, 6, 'two native batches and one exported log batch retain their own drop counts')
  assert.equal(exported.traceEvents.length, 3 * serverEvents.length + laterServerBatch.length + browserEvents.length)
  // The arbitrary `secret` argument is redacted by the shared sanitizer, so identical batches are compared to that shape.
  const redactedServerEvent = { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 9_000_000_000, dur: 4_000, pid: 'server:4242', tid: 1, args: { traceId } }
  assert.equal(exported.traceEvents.filter(event => JSON.stringify(event) === JSON.stringify(redactedServerEvent)).length, 3)
  assert.doesNotMatch(stdout, /PRIVATE_PROMPT_TEXT/, 'arbitrary JSON args never leave the report')
  assert.deepEqual(exported.traceEvents.map(event => event.name).sort(),
    [...browserEvents, ...serverEvents, ...serverEvents, ...serverEvents, ...laterServerBatch].map(event => event.name).sort())
})

test('the loader is importable without running the CLI and returns only sanitized fields', async t => {
  const dir = await fixtureDirectory(t)
  const leaking = {
    traceEvents: [
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 10, dur: 5, pid: 'server:4242', tid: 9, args: { traceId, turnId: 2, url: 'https://example.test/?token=PRIVATE_TOKEN', sessionId: '../../PRIVATE_PATH' } },
      { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 10, dur: 5, pid: '/Users/PRIVATE_HOME', tid: 1, args: { traceId } },
      { name: 'prompt.unknown', cat: 'fx0', ph: 'i', ts: 10, pid: 'browser', tid: 1, args: { traceId } },
    ],
    displayTimeUnit: 'ms',
    dropped: 4,
  }
  await writeFile(path.join(dir, 'server-4242.jsonl'), JSON.stringify(leaking) + '\n')
  // A test runner's own argv must not make the imported module run the CLI.
  const { loadTraceFiles } = await import('../scripts/trace-report.mjs')
  const loaded = await loadTraceFiles([dir])
  assert.equal(process.exitCode, undefined, 'importing the module sets no exit code')
  assert.equal(loaded.dropped, 4)
  assert.equal(loaded.traceEvents.length, 1, 'invalid lanes and unknown names are rejected, not exported')
  assert.deepEqual(loaded.traceEvents[0], { name: 'request.handle', cat: 'fx0', ph: 'X', ts: 10, dur: 5, pid: 'server:4242', tid: 1, args: { traceId, turnId: 2 } })
  assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE_/)
})

test('a native batch with a malformed drop count fails instead of reporting a clean total', async t => {
  const dir = await fixtureDirectory(t)
  const file = path.join(dir, 'browser.json')
  await writeFile(file, JSON.stringify({ traceEvents: browserEvents, displayTimeUnit: 'ms', dropped: -1 }))
  await assert.rejects(run(process.execPath, [script, file], { timeout: 10000 }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Invalid trace drop count/)
    assert.doesNotMatch(error.stderr, /\n\s+at /, 'no stack trace')
    return true
  })
})
