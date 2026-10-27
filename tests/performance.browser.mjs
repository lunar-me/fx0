import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

test('browser CPU baseline: event replay, transcript, and draft work across document/history sizes', { timeout: 120_000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'fx0-perf-browser-'))
  const modules = new Map()
  const server = createServer((request, response) => {
    if (modules.has(request.url)) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(modules.get(request.url))
    } else if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body><pre id="out">pending</pre>
        <script type="module">
        import {runBenchmark} from '/benchmark.mjs';
        try { document.getElementById('out').textContent=JSON.stringify(runBenchmark()) }
        catch(error) { document.getElementById('out').textContent=JSON.stringify({error:String(error.stack)}) }
        </script></body></html>`)
    } else response.writeHead(404).end()
  })
  try {
    for (const name of ['lib/trace-browser', 'lib/performance-trace', 'lib/prompt-trace', 'lib/draft-preview',
      'lib/design-draft', 'lib/transcript', 'lib/event-delivery', 'components/chat-state']) {
      const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8')
      const compiled = stripTypeScriptTypes(source)
        .replaceAll('process.env.NEXT_PUBLIC_FX0_TRACE_SCOPE', "'local'")
        .replaceAll('process.env.NEXT_PUBLIC_FX0_TRACE', 'globalThis.__fx0PerfTrace')
      modules.set(`/${name}.ts`, compiled)
      modules.set(`/${name}`, compiled)
    }
    modules.set('/benchmark.mjs', await readFile(new URL('./fixtures/performance-browser.mjs', import.meta.url), 'utf8'))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    // No virtual-time budget: these durations must use Chrome's real monotonic clock.
    const { stdout } = await promisify(execFile)(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom',
      `http://127.0.0.1:${server.address().port}/`], { timeout: 110_000, maxBuffer: 16 * 1024 * 1024 })
    const match = stdout.match(/<pre id="out">([^<]+)<\/pre>/)
    assert.ok(match, 'Chrome returned the benchmark result')
    const result = JSON.parse(match[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'))
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.scenarios.length, 12)
    for (const scenario of result.scenarios) {
      assert.equal(scenario.valid, true, `workload was exercised: ${scenario.inputKiB} KiB, ${scenario.historyTurns} turns, tracing=${scenario.traceEnabled}`)
      assert.equal(scenario.samples, 30)
      assert.equal(scenario.cpu.count, scenario.samples)
      assert.equal(scenario.phases.length, 5)
      assert.ok(scenario.cpu.p50 >= 0 && scenario.cpu.p95 >= scenario.cpu.p50)
      assert.ok(scenario.endingBytes >= scenario.startingBytes && scenario.startingBytes >= scenario.inputKiB * 1024)
      assert.equal(scenario.capture.dropped, 0)
      assert.equal(scenario.capture.traceEvents.length, scenario.traceEnabled ? scenario.samples * 3 : 0)
      for (const phase of scenario.phases) assert.equal(phase.count, scenario.samples)
      assert.doesNotMatch(JSON.stringify(scenario.capture), /Synthetic request|Benchmark card|<section|<html/)
    }
    const run = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`
    const directory = path.join('.next', 'fx0-perf', run)
    await mkdir(directory, { recursive: true })
    const trace = { traceEvents: result.scenarios.flatMap(scenario => scenario.capture.traceEvents), displayTimeUnit: 'ms', dropped: 0 }
    const summary = { ...result, node: process.version,
      scenarios: result.scenarios.map(({ capture: _capture, ...scenario }) => scenario) }
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2))
    await writeFile(path.join(directory, 'trace.json'), JSON.stringify(trace))
    console.log(result.scope)
    console.table(summary.scenarios.map(scenario => ({
      'HTML KiB': scenario.inputKiB, turns: scenario.historyTurns, tracing: scenario.traceEnabled ? 'on' : 'off',
      'p50 ms': +scenario.cpu.p50.toFixed(3), 'p95 ms': +scenario.cpu.p95.toFixed(3),
      '>16.7 ms': `${scenario.overFrameBudget}/${scenario.samples}`,
    })))
    console.log('Tracing-on phase breakdown (mean synchronous time; exclusive measured phases):')
    console.table(summary.scenarios.filter(scenario => scenario.traceEnabled).map(scenario => {
      const row = { 'HTML KiB': scenario.inputKiB, turns: scenario.historyTurns }
      for (const phase of scenario.phases) row[phase.name] = +phase.mean.toFixed(3)
      return row
    }))
    console.log(`Artifacts: ${directory}/summary.json and ${directory}/trace.json`)
    console.log('Inspect spans: node scripts/trace-report.mjs ' + path.join(directory, 'trace.json'))
    console.log('Timing thresholds are diagnostic, not pass/fail gates. Model, services, React commits, layout, and paint are not measured.')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(profile, { recursive: true, force: true })
  }
})
