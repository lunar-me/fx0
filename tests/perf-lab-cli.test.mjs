import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Offline only: no Chrome, no server, no model. Live `run`/`ab`/`login` are exercised by hand.
const cli = fileURLToPath(new URL('../scripts/perf-lab.mjs', import.meta.url))
const exec = (args, options = {}) => promisify(execFile)(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { timeout: 20000, ...options })
const traceId = 'c'.repeat(32)
const sessionId = '00000000-0000-4000-8000-000000000009'
const at = ms => 1_800_000_000_000_000 + ms * 1000
const browser = {
  displayTimeUnit: 'ms', dropped: 0,
  traceEvents: [
    { name: 'prompt.started', cat: 'fx0', ph: 'i', s: 't', ts: at(0), pid: 'browser', tid: 1, args: { traceId } },
    { name: 'prompt.send', cat: 'fx0', ph: 'X', ts: at(100), dur: 900_000, pid: 'browser', tid: 1, args: { traceId, sessionId, status: 200, failed: false } },
    { name: 'prompt.acknowledged', cat: 'fx0', ph: 'i', s: 't', ts: at(1000), pid: 'browser', tid: 1, args: { traceId } },
    { name: 'prompt.first_content', cat: 'fx0', ph: 'i', s: 't', ts: at(2000), pid: 'browser', tid: 1, args: { traceId, sessionId, turnId: 1 } },
    { name: 'prompt.finished', cat: 'fx0', ph: 'i', s: 't', ts: at(2001), pid: 'browser', tid: 1, args: { traceId, sessionId, turnId: 1, seq: 4 } },
    { name: 'prompt.turn', cat: 'fx0', ph: 'X', ts: at(0), dur: 2_001_000, pid: 'browser', tid: 1, args: { traceId, seq: 4 } },
    { name: 'prompt.e2e', cat: 'fx0', ph: 'X', ts: at(0), dur: 2_001_000, pid: 'browser', tid: 1, args: { traceId, seq: 4 } },
  ],
}
const server = {
  displayTimeUnit: 'ms', dropped: 0,
  traceEvents: [
    { name: 'prompt.accepted', cat: 'fx0', ph: 'X', ts: at(500), dur: 20_000, pid: 'server:42', tid: 1, args: { traceId, sessionId, turnId: 1 } },
    // Another prompt's span in the same server file must not join this run.
    { name: 'model.headers', cat: 'fx0', ph: 'X', ts: at(600), dur: 1_000_000, pid: 'server:42', tid: 1, args: { traceId: 'd'.repeat(32) } },
  ],
}

async function lab(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx0-perf-lab-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(browser))
  await writeFile(path.join(directory, 'server-42.jsonl'), JSON.stringify(server) + '\n')
  return directory
}

test('import saves one run joined by trace id and writes offline HTML reports', async t => {
  const directory = await lab(t)
  const out = path.join(directory, 'lab')
  await exec(['import', '--browser', path.join(directory, 'browser.json'), '--server', directory, '--out', out, '--workload', 'reply-ok'])
  const [file] = await readdir(path.join(out, 'runs'))
  const saved = JSON.parse(await readFile(path.join(out, 'runs', file), 'utf8'))
  assert.equal(saved.id, traceId)
  assert.equal(saved.status, 'complete')
  assert.equal(saved.metrics.firstTextMs, 2000)
  assert.deepEqual(saved.trace.traceEvents.filter(event => event.pid !== 'browser').map(event => event.name), ['prompt.accepted'])
  const html = await readFile(path.join(out, 'index.html'), 'utf8')
  assert.match(html, /fx0 performance lab/)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i, 'reports are self-contained')
  assert.equal((await readdir(path.join(out, 'reports'))).length, 1)
})

test('report compares both labels and refuses deltas when settings are unknown', async t => {
  const directory = await lab(t)
  const out = path.join(directory, 'lab')
  const common = ['--browser', path.join(directory, 'browser.json'), '--server', directory, '--out', out]
  await exec(['import', ...common, '--label', 'baseline', '--pair', '1'])
  const other = { ...browser, traceEvents: browser.traceEvents.map(event => ({ ...event, args: { ...event.args, traceId: 'e'.repeat(32) } })) }
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify(other))
  const { stdout } = await exec(['import', ...common, '--label', 'candidate', '--pair', '1'])
  assert.match(stdout, /Not comparable: .*model_unknown/)
  const comparison = JSON.parse(await readFile(path.join(out, 'comparison.json'), 'utf8'))
  assert.equal(comparison.compatible, false)
  assert.deepEqual(comparison.metrics, [])
})

test('think time becomes part of a workload id the run validator accepts', async () => {
  const { workloadFor } = await import('../scripts/perf-lab.mjs')
  const { createRun } = await import('../scripts/lib/perf-lab-data.mjs')
  assert.equal(workloadFor({}, 'Reply exactly OK. Do not use tools.'), 'reply-ok')
  assert.equal(workloadFor({ 'think-ms': '3000' }, 'Reply exactly OK. Do not use tools.'), 'reply-ok-think3000ms')
  assert.equal(workloadFor({ 'think-ms': '3000', workload: 'bookshop' }, 'x'), 'bookshop-think3000ms')
  assert.throws(() => workloadFor({ 'think-ms': '-1' }, 'x'))
  assert.equal(workloadFor({ 'follow-up-gap-ms': '0' }, 'Reply exactly OK. Do not use tools.'), 'reply-ok-gap0ms')
  assert.equal(workloadFor({ 'think-ms': '3000', 'follow-up-gap-ms': '300000' }, 'Reply exactly OK. Do not use tools.'), 'reply-ok-think3000ms-gap300000ms')
  assert.throws(() => workloadFor({ 'follow-up-gap-ms': 'soon' }, 'x'))
  const metadata = {
    environment: 'vercel-preview', durability: 'vercel', condition: 'cold', workloadHash: null, model: 'unknown',
    reasoningEffort: 'unknown', fast: null, accountHash: null, teamHash: null, viewport: null, revision: null,
    sourceHash: null, instrumentation: 'fx0-trace-v1', history: 'new-chat', capture: 'headless', startBoundary: 'handler',
  }
  const run = workload => createRun({ browser, server, metadata: { ...metadata, workload }, label: 'baseline', recordedAt: '2026-10-27T00:00:00.000Z' })
  for (const workload of ['reply-ok', 'reply-ok-think3000ms', 'reply-ok-think3000ms-gap300000ms']) assert.equal(run(workload).metadata.workload, workload)
  assert.throws(() => run('reply-ok@think3000ms'), /workload/, 'the validator rejects the old suffix')
})

test('a lab inside .next is refused before anything is written, since next build deletes it', async t => {
  const directory = await lab(t)
  const out = path.join(directory, '.next', 'fx0-lab', 'x')
  await assert.rejects(exec(['import', '--browser', path.join(directory, 'browser.json'), '--server', directory, '--out', out]),
    error => /--out must be outside \.next/.test(error.stderr))
  await assert.rejects(readdir(path.join(directory, '.next')), { code: 'ENOENT' })
})

test('schedule is balanced and reproducible; missing options fail before any capture', async () => {
  const first = (await exec(['schedule', '--pairs', '6', '--seed', 'fx0'])).stdout
  assert.equal(first, (await exec(['schedule', '--pairs', '6', '--seed', 'fx0'])).stdout)
  assert.equal((first.match(/baseline -> candidate/g) ?? []).length, 3)
  assert.equal((first.match(/candidate -> baseline/g) ?? []).length, 3)
  await assert.rejects(exec(['ab', '--pairs', '2']), error => /--profile is required/.test(error.stderr))
  await assert.rejects(exec(['run', '--profile', '/tmp/x', '--url', 'https://example.com', '--out', '/tmp/x']), error => error.code === 1)
})
