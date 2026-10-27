import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { enterIntervalsMs, inspectCapture, parseArgs, run, sanitizeSnapshot, submitWithEnter } from '../scripts/perf-e2e.mjs'
import { connectCdp, createPerfProfile, inspectorJson, labTargetUrl, launchChrome, loopbackUrl } from './fixtures/chrome-cdp.mjs'

const runner = fileURLToPath(new URL('../scripts/perf-e2e.mjs', import.meta.url))
const execute = promisify(execFile)

test('--help exits 0 without Chrome; invalid arguments exit 2 before process launch', async () => {
  const env = { ...process.env, CHROME_PATH: '/no-such-chrome-for-help' }
  const result = await execute(process.execPath, [runner, '--help'], { env, timeout: 5000 })
  assert.match(result.stdout, /Usage: node scripts\/perf-e2e\.mjs/)
  assert.match(result.stdout, /LIVE prompt/)
  assert.match(result.stdout, /--headed +Show a fresh Chrome window/)
  assert.match(result.stdout, /Chrome runs headless by default/)
  assert.equal(result.stderr, '')
  for (const args of [[], ['--url', 'https://example.com'], ['--url', 'http://user:secret@localhost:3000']]) {
    await assert.rejects(execute(process.execPath, [runner, ...args], { env, timeout: 5000 }), error => {
      assert.equal(error.code, 2)
      assert.doesNotMatch(error.stderr, /Chrome not found|secret|LIVE prompt/)
      return true
    })
  }
})

test('headless auth guard refuses an editable signed-out draft before the send click', { timeout: 15000 }, async () => {
  let clicks = 0
  // Readiness-contract fixture only: no app, model, generated output, or E2E latency.
  const server = createServer((request, response) => {
    if (request.url === '/clicked') { clicks++; response.end(); return }
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><div data-fx0-prompt-state="auth"><textarea id="prompt"></textarea><button aria-label="Send message" onclick="fetch(\'/clicked\')">Send</button></div>')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await assert.rejects(execute(process.execPath, [runner, '--url', `http://127.0.0.1:${server.address().port}`,
      '--headless', '--timeout-ms', '5000'], { timeout: 10000 }), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Authentication required/)
      assert.match(error.stderr, /no prompt was sent/)
      return true
    })
    assert.equal(clicks, 0)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('argument validation is loopback-only, bounded, and never echoes unsafe input', () => {
  assert.equal(parseArgs(['--help']).help, true)
  const defaults = parseArgs(['--url', 'http://localhost:3000'])
  assert.equal(defaults.timeoutMs, 180000)
  assert.equal(defaults.headless, true)
  assert.equal(parseArgs(['--url', 'http://[::1]:3000', '--headless', '--timeout-ms', '2000']).headless, true)
  assert.equal(parseArgs(['--url', 'http://localhost:3000', '--headed']).headless, false)
  for (const conflict of [['--headed', '--headless'], ['--headless', '--headed']]) {
    assert.throws(() => parseArgs(['--url', 'http://localhost:3000', ...conflict]), /conflict/)
  }
  assert.throws(() => parseArgs(['--url', 'http://localhost:3000', '--headed', '--headed']), /Duplicate/)
  for (const url of ['http://127.0.0.2:3000', 'https://localhost:3000/path?q=not-persisted', 'http://[::1]:3000']) assert.ok(loopbackUrl(url))
  for (const url of ['https://example.com', 'file:///tmp/foo', 'http://localhost.example.com', 'http://0.0.0.0',
    'http://169.254.169.254', 'http://192.168.1.1', 'http://localhost:0', 'http://@localhost',
    'http://user:secret@localhost', 'http:localhost', 'http://localhost\\@example.com', ' http://localhost', 'http://localhost\n']) {
    assert.throws(() => parseArgs(['--url', url]))
  }
  for (const extra of [['--unknown'], ['--url', 'http://localhost'], ['--prompt'], ['--timeout-ms', '1e6'],
    ['--timeout-ms', '-1'], ['--timeout-ms', '0'], ['--timeout-ms', '3600001'], ['--prompt', '/command'],
    ['--prompt', ''], ['--prompt', 'x'.repeat(16001)], ['--prompt', 'unsafe\u0000text']]) {
    assert.throws(() => parseArgs(['--url', 'http://localhost:3000', ...extra]))
  }
  assert.equal(parseArgs(['--url', 'http://localhost:3000', '--prompt', 'Quote " and backtick `\nnext line']).prompt, 'Quote " and backtick `\nnext line')
})

test('a live run targets only this machine or an fx0 preview over HTTPS, never production', () => {
  assert.equal(labTargetUrl('http://localhost:3000').kind, 'local')
  for (const url of ['https://fx0-git-esteban-fx0-request-tracing.labs.vercel.dev/', 'https://fx0-abc123.labs.vercel.dev',
    'https://fx0-git-branch-team.vercel.app/?s=00000000-0000-4000-8000-000000000001']) {
    assert.equal(labTargetUrl(url).kind, 'preview')
    assert.equal(parseArgs(['--url', url]).url, new URL(url).href)
  }
  for (const url of ['https://fx0.vercel.dev', 'https://fx0.vercel.app', 'https://fx0.labs.vercel.dev', 'http://fx0-abc.labs.vercel.dev',
    'https://fx0-abc.labs.vercel.dev:8443', 'https://user:pass@fx0-abc.labs.vercel.dev', 'https://fx0-abc.labs.vercel.dev.evil.com',
    'https://evil.com/fx0-abc.labs.vercel.dev', 'https://other-abc.labs.vercel.dev', 'https://fx0-abc.vercel.dev']) {
    assert.throws(() => labTargetUrl(url), /production is never measured|loopback or an fx0 preview|Invalid URL/, url)
    assert.throws(() => parseArgs(['--url', url]), url)
  }
})

test('trace output boundary drops content and does not mistake stream end for completion', () => {
  const snapshot = sanitizeSnapshot({ traceEvents: [
    { name: 'model.stream', ph: 'X', ts: 1, dur: 4, pid: 'private', args: { prompt: 'secret', cookie: 'secret', bytes: 10 } },
    { name: 'private-content', ph: 'i', ts: 2, args: {} },
  ], secret: 'secret' })
  assert.equal(snapshot.traceEvents.length, 1)
  assert.deepEqual(snapshot.traceEvents[0].args, { bytes: 10 })
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private/)
  assert.deepEqual(inspectCapture(snapshot), { complete: false })
  assert.throws(() => sanitizeSnapshot({ traceEvents: new Array(10001) }))
})

test('incomplete/cancelled/failed roots cannot be reported as successful', () => {
  // Trace-contract unit inputs only, not a generation or a performance result.
  const traceId = 'a'.repeat(32)
  const start = { name: 'prompt.started', ph: 'i', ts: 1, args: { traceId } }
  for (const flag of ['failed', 'cancelled', 'incomplete']) {
    assert.throws(() => inspectCapture({ traceEvents: [start,
      { name: 'prompt.e2e', ph: 'X', ts: 1, dur: 3, args: { traceId, [flag]: true } },
    ] }), /failed, cancelled, or incomplete/)
  }
  assert.throws(() => inspectCapture({ traceEvents: [start, start] }), /More than one/)
  assert.throws(() => inspectCapture({ traceEvents: [start,
    { name: 'prompt.e2e', ph: 'X', ts: 1, dur: 3, args: { traceId } },
  ] }), /journal completion/)
})

test('an SSE disconnect does not fail a root that is still waiting for journal completion', () => {
  const traceId = 'a'.repeat(32)
  const snapshot = { traceEvents: [
    { name: 'prompt.started', ph: 'i', ts: 1, args: { traceId } },
    { name: 'sse.receive', ph: 'X', ts: 2, dur: 3, args: { traceId, failed: true } },
  ] }
  assert.deepEqual(inspectCapture(snapshot), { complete: false, traceId })
})

test('trace-contract arithmetic uses browser-relative time and requires the final revision paint', () => {
  // Handwritten trace-contract inputs only: never emitted as a live E2E result.
  const traceId = 'a'.repeat(32)
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const context = { traceId, sessionId, turnId: 1 }
  const instant = (name, ts, args = {}) => ({ name, ph: 'i', ts, args: { ...context, ...args } })
  const snapshot = { traceEvents: [
    instant('prompt.started', 1000), instant('prompt.acknowledged', 2000),
    instant('prompt.first_draft', 3000), instant('prompt.finished', 5000, { seq: 8, revision: 2 }),
    { name: 'prompt.turn', ph: 'X', ts: 1000, dur: 4000, args: context },
    { name: 'prompt.e2e', ph: 'X', ts: 1000, dur: 6000, args: { ...context, revision: 2 } },
  ] }
  assert.throws(() => inspectCapture(snapshot), /Final artifact paint/)
  snapshot.traceEvents.push(instant('preview.presented', 6000, { revision: 1 }))
  assert.throws(() => inspectCapture(snapshot), /Final artifact paint/)
  snapshot.traceEvents.push(instant('preview.presented', 7000, { revision: 2 }))
  const result = inspectCapture(snapshot)
  assert.equal(result.elapsedMs, 6)
  assert.equal(result.milestonesMs['prompt.started'], 0)
  assert.equal(result.milestonesMs['prompt.first_draft'], 2)
  assert.equal(result.milestonesMs['prompt.first_content'], null)
  assert.equal(result.finalArtifactPaintMs, 6)
  assert.deepEqual(result.stages.map(stage => stage.durationMs), [4, 6])
})

test('Enter-relative intervals are browser-clock arithmetic; missing or backwards inputs are null', () => {
  // Pure arithmetic on handwritten microsecond timestamps. Not a measurement.
  assert.deepEqual(enterIntervalsMs(1000, { handler: 3000, acknowledged: 1000, firstContent: null, firstDraft: Number.NaN, finished: 500 }),
    { handler: 2, acknowledged: 0, firstContent: null, firstDraft: null, finished: null })
  assert.deepEqual(enterIntervalsMs(undefined, { handler: 3000 }), { handler: null })
  assert.deepEqual(enterIntervalsMs(Number.NaN, { handler: 3000 }), { handler: null })
})

test('inspectCapture adds Enter-relative milestones and rejects a milestone before the Enter', () => {
  // Trace-contract inputs only, reusing the arithmetic fixture above.
  const traceId = 'a'.repeat(32)
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const context = { traceId, sessionId, turnId: 1 }
  const instant = (name, ts, args = {}) => ({ name, ph: 'i', ts, args: { ...context, ...args } })
  const snapshot = { traceEvents: [
    instant('prompt.started', 1000), instant('prompt.acknowledged', 2000),
    instant('prompt.first_draft', 3000), instant('prompt.finished', 5000, { seq: 8, revision: 2 }),
    instant('preview.presented', 7000, { revision: 2 }),
    { name: 'prompt.turn', ph: 'X', ts: 1000, dur: 4000, args: context },
    { name: 'prompt.e2e', ph: 'X', ts: 1000, dur: 6000, args: { ...context, revision: 2 } },
  ] }
  assert.throws(() => inspectCapture(snapshot, 1500), /precedes the observed Enter/)
  assert.throws(() => inspectCapture(snapshot, Number.NaN), /Invalid Enter timestamp/)
  const withEnter = inspectCapture(snapshot, 400)
  assert.deepEqual(withEnter.enterToMs, { handler: 0.6, acknowledged: 1.6, firstContent: null, firstDraft: 2.6, finished: 4.6 })
  assert.equal(withEnter.milestonesMs['prompt.started'], 0)
  assert.equal(withEnter.elapsedMs, 6)
  assert.deepEqual(inspectCapture(snapshot).enterToMs, { handler: null, acknowledged: null, firstContent: null, firstDraft: null, finished: null })
})

test('the runner never brings the Chrome page to front and keeps the headless default', async () => {
  const source = await readFile(runner, 'utf8')
  assert.doesNotMatch(source, /bringToFront/)
  assert.match(source, /headless: true,/)
})

test('real headless Chrome on about:blank: one trusted Enter, zero clicks, and no retry', { timeout: 20000 }, async () => {
  const browser = await launchChrome({ headless: true })
  const { cdp } = browser
  try {
    // A synthetic composer fixture only: no app, model, draft content, or generation.
    await cdp.evaluate(`(() => {
      document.body.innerHTML = '<div data-fx0-prompt-state="ready"><textarea id="prompt-input"></textarea><button aria-label="Send message">Send</button></div>';
      window.__keys = []; window.__clicks = 0;
      document.addEventListener('keydown', event => window.__keys.push({ trusted: event.isTrusted, key: event.key }), true);
      document.querySelector('button').addEventListener('click', () => window.__clicks++);
      document.querySelector('textarea').value = 'synthetic draft';
    })()`)
    const origin = await cdp.evaluate('location.origin')
    // Every refusal happens before any key event is dispatched.
    await assert.rejects(submitWithEnter(cdp, 'http://localhost:1'), /App origin changed/)
    await cdp.evaluate(`document.querySelector('textarea').value = ''`)
    await assert.rejects(submitWithEnter(cdp, origin), /Draft is empty/)
    await cdp.evaluate(`document.querySelector('textarea').value = 'synthetic draft';
      document.querySelector('[data-fx0-prompt-state]').dataset.fx0PromptState = 'auth'`)
    await assert.rejects(submitWithEnter(cdp, origin), /not ready/)
    await cdp.evaluate(`document.querySelector('[data-fx0-prompt-state]').dataset.fx0PromptState = 'ready'`)
    assert.equal(await cdp.evaluate('window.__keys.length'), 0)

    const { enterTimestampUs } = await submitWithEnter(cdp, origin)
    assert.deepEqual(await cdp.evaluate('window.__keys'), [{ trusted: true, key: 'Enter' }])
    assert.equal(await cdp.evaluate('window.__clicks'), 0)
    assert.equal(typeof enterTimestampUs, 'number')
    const now = await cdp.evaluate('(performance.timeOrigin + performance.now()) * 1000')
    assert.ok(enterTimestampUs <= now && now - enterTimestampUs < 60_000_000, 'timestamp is on the browser clock')
  } finally {
    await browser.close()
  }
})

test('real headless Chrome on about:blank: evaluation, JS errors, and closing an outstanding awaitPromise', async () => {
  const browser = await launchChrome({ headless: true })
  const { cdp } = browser
  try {
    assert.equal(await cdp.evaluate('location.href'), 'about:blank')
    assert.equal(await cdp.evaluate('2 + 2'), 4)
    await assert.rejects(cdp.evaluate('(() => { throw new Error("private JavaScript exception") })()'), error => {
      assert.equal(error.message, 'Browser evaluation failed (no page content captured)')
      return true
    })
    const pending = assert.rejects(
      cdp.evaluate('globalThis.__cdpPending = true; new Promise(() => {})'),
      /CDP connection closed/,
    )
    // This round trip proves Chrome entered the unresolved awaitPromise before close.
    assert.equal(await cdp.evaluate('globalThis.__cdpPending'), true)
    await browser.close()
    await pending
    await assert.rejects(cdp.evaluate('2 + 2'), /CDP connection is not open/)
  } finally {
    await browser.close() // Also exercises idempotent process/profile cleanup.
  }
})

test('CDP refuses foreign inspector endpoints without connecting', async () => {
  await assert.rejects(connectCdp('ws://example.com:3000/devtools/page/fixture', { port: 3000 }), /owned loopback/)
  await assert.rejects(connectCdp('ws://127.0.0.1:3001/devtools/page/fixture', { port: 3000 }), /owned loopback/)
  await assert.rejects(connectCdp('ws://user:secret@127.0.0.1:3000/devtools/page/fixture', { port: 3000 }), /owned loopback/)
  assert.throws(() => inspectorJson(3000, '/cookies'), /Invalid inspector/)
})

// Persistent-profile tests. Only headless Chrome on about:blank or a loopback fixture is ever launched.
const markerName = '.fx0-perf-profile.json'
const chromeUserData = path.join(homedir(), 'Library/Application Support/Google/Chrome')
const sessionId = '00000000-0000-4000-8000-000000000001'

async function tempRoot() { return mkdtemp(path.join(tmpdir(), 'fx0-perf-test-')) }
async function chromeTempEntries() { return (await readdir(tmpdir())).filter(name => name.startsWith('fx0-perf-chrome-')) }

// Synthetic app stand-in: the composer, trace hook and /api/model reply, but no app code or model.
function fixturePage(state) {
  return `<!doctype html><meta charset="utf-8"><div data-fx0-prompt-state="${state}" style="margin:40px">
<textarea id="prompt" style="width:300px;height:60px"></textarea>
<button aria-label="Send message" style="width:120px;height:40px">Send</button></div>
<script>
  const ids = { traceId: 'a'.repeat(32), sessionId: '${sessionId}', turnId: 1 };
  let events = [];
  window.__fx0Trace = { snapshot: () => ({ traceEvents: events.slice(), dropped: 0 }), clear: () => { events = [] } };
  document.querySelector('#prompt').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || events.length) return;
    const t0 = (performance.timeOrigin + performance.now()) * 1000;
    events = [
      { name: 'prompt.started', ph: 'i', ts: t0, args: ids },
      { name: 'prompt.turn', ph: 'X', ts: t0 + 50, dur: 500, args: ids },
      { name: 'prompt.finished', ph: 'i', ts: t0 + 100, args: { ...ids, seq: 1, revision: 1 } },
      { name: 'preview.presented', ph: 'i', ts: t0 + 200, args: { ...ids, revision: 1 } },
      { name: 'prompt.e2e', ph: 'X', ts: t0, dur: 1000, args: { ...ids, revision: 1 } },
    ];
  });
</script>`
}

async function startFixture() {
  const fixture = { state: 'ready', model: { model: 'fixture-model', effort: 'low', fast: true } }
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/model?session=')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(fixture.model))
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(fixturePage(fixture.state))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { fixture, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) }
}

test('createPerfProfile writes a 0700 directory and 0600 marker, and refuses unmarked or Chrome paths', async () => {
  const root = await tempRoot()
  try {
    const dir = path.join(root, 'profile')
    const real = await createPerfProfile(dir)
    assert.equal(real, await realpath(dir))
    assert.equal((await lstat(dir)).mode & 0o777, 0o700)
    const marker = path.join(dir, markerName)
    assert.equal((await lstat(marker)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { version: 1, purpose: 'fx0-performance' })
    assert.equal(await createPerfProfile(dir), real, 'an existing valid profile is accepted without rewriting')
    const unmarked = path.join(root, 'unmarked')
    await mkdir(unmarked)
    await writeFile(path.join(unmarked, 'note.txt'), 'x')
    await assert.rejects(createPerfProfile(unmarked), /not empty/)
    await assert.rejects(createPerfProfile(path.join(root, 'missing', 'child')), error => error.code === 'ENOENT')
    for (const target of [chromeUserData, path.join(chromeUserData, 'Default')]) {
      await assert.rejects(createPerfProfile(target), /Chrome user data directory/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('persistent profiles are refused before Chrome starts: bad marker, symlinks, Chrome paths, and a locked profile', async () => {
  const root = await tempRoot()
  try {
    const reject = /missing a valid fx0 performance marker|real directory|in use by a Chrome process/
    const cases = {
      'marker missing': async dir => rm(path.join(dir, markerName)),
      'marker with extra key': async dir => writeFile(path.join(dir, markerName), JSON.stringify({ version: 1, purpose: 'fx0-performance', extra: true })),
      'marker wrong version': async dir => writeFile(path.join(dir, markerName), JSON.stringify({ version: 2, purpose: 'fx0-performance' })),
      'marker not JSON': async dir => writeFile(path.join(dir, markerName), 'not json'),
      'marker is null JSON': async dir => writeFile(path.join(dir, markerName), 'null'),
      'marker is a symlink': async dir => {
        const other = await createPerfProfile(path.join(root, 'other'))
        await rm(path.join(dir, markerName))
        await symlink(path.join(other, markerName), path.join(dir, markerName))
      },
      'SingletonLock of another host': async dir => symlink('elsewhere-1234', path.join(dir, 'SingletonLock')),
      'SingletonLock of a live process': async dir => symlink(`${hostname()}-${process.pid}`, path.join(dir, 'SingletonLock')),
    }
    for (const [name, mutate] of Object.entries(cases)) {
      const dir = await createPerfProfile(path.join(root, name.replace(/\W+/g, '-')))
      await mutate(dir)
      await assert.rejects(launchChrome({ headless: true, profileDirectory: dir, timeoutMs: 5000 }), reject, name)
    }
    const real = await createPerfProfile(path.join(root, 'real-profile'))
    await symlink(real, path.join(root, 'linked-profile'))
    await assert.rejects(launchChrome({ headless: true, profileDirectory: path.join(root, 'linked-profile'), timeoutMs: 5000 }), /existing real directory/)
    // Path-only refusal: nothing under Chrome's user data is stat'ed, created, or read.
    for (const target of [chromeUserData, path.join(chromeUserData, 'Default'), path.join(homedir(), 'Library/Application Support/Google/Chrome Beta'),
      path.join(homedir(), 'Library/Application Support/Google/Chrome Canary'), path.join(homedir(), 'Library/Application Support/Chromium'),
      path.join(homedir(), '.config/google-chrome')]) {
      await assert.rejects(launchChrome({ headless: true, profileDirectory: target, timeoutMs: 5000 }), /Refusing a Chrome user data directory/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('persistent headless Chrome keeps its owned profile, reuses it, and ignores a stale DevToolsActivePort', { timeout: 30000 }, async () => {
  const root = await tempRoot()
  try {
    const dir = await createPerfProfile(path.join(root, 'profile'))
    await writeFile(path.join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/stale\n')
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = await launchChrome({ headless: true, profileDirectory: dir })
      try {
        assert.equal(await browser.cdp.evaluate('location.href'), 'about:blank')
        assert.equal(await browser.cdp.evaluate('2 + 2'), 4)
      } finally { await browser.close() }
      assert.ok((await lstat(path.join(dir, markerName))).isFile(), `marker kept after close ${attempt + 1}`)
      assert.ok((await stat(dir)).isDirectory(), `directory kept after close ${attempt + 1}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the default temporary profile is still deleted on close', { timeout: 20000 }, async () => {
  const before = await chromeTempEntries()
  const browser = await launchChrome({ headless: true })
  try { assert.equal(await browser.cdp.evaluate('2 + 2'), 4) }
  finally { await browser.close() }
  assert.deepEqual((await chromeTempEntries()).filter(name => !before.includes(name)), [])
})

test('--profile parses to a resolved path, and its errors never echo the path', async () => {
  const base = ['--url', 'http://localhost:3000']
  assert.equal(parseArgs([...base, '--profile', '/tmp/fx0-profile-example']).profileDirectory, '/tmp/fx0-profile-example')
  assert.equal(parseArgs([...base, '--profile', 'relative-dir']).profileDirectory, path.resolve('relative-dir'))
  assert.equal(parseArgs(base).profileDirectory, undefined)
  assert.equal(parseArgs([...base, '--headed', '--profile', '/tmp/fx0-profile-example']).headless, false)
  for (const extra of [['--profile'], ['--profile', '--headed'], ['--profile', '   '], ['--profile', 'secret\u0000dir'],
    ['--profile', 'a', '--profile', 'b']]) {
    assert.throws(() => parseArgs([...base, ...extra]), error => {
      assert.doesNotMatch(error.message, /secret|dir\b|\ba\b/)
      return true
    })
  }
  const help = await execute(process.execPath, [runner, '--help'], { timeout: 5000 })
  assert.match(help.stdout, /--profile +Dedicated persistent Chrome profile/)
})

test('a run with an invalid profile fails before Chrome and attaches artifactDirectory', { timeout: 20000 }, async () => {
  const root = await tempRoot()
  const { url, close } = await startFixture()
  let artifactDirectory
  try {
    const unmarked = path.join(root, 'unmarked')
    await mkdir(unmarked)
    await assert.rejects(run({ url, headless: true, timeoutMs: 5000, prompt: 'synthetic', profileDirectory: unmarked }), error => {
      assert.equal(error.message, 'Persistent profile is missing a valid fx0 performance marker')
      assert.equal(typeof error.artifactDirectory, 'string')
      artifactDirectory = error.artifactDirectory
      return true
    })
    const summary = JSON.parse(await readFile(path.join(artifactDirectory, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.artifactDirectory, artifactDirectory)
  } finally {
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true })
    await close()
    await rm(root, { recursive: true, force: true })
  }
})

test('run uses a dedicated profile for an authenticated headless run and keeps it after failure', { timeout: 30000 }, async () => {
  const root = await tempRoot()
  const { fixture, url, close } = await startFixture()
  const dir = await createPerfProfile(path.join(root, 'profile'))
  let artifactDirectory
  try {
    fixture.state = 'auth'
    await assert.rejects(run({ url, headless: true, timeoutMs: 15000, prompt: 'synthetic', profileDirectory: dir }), error => {
      assert.match(error.message, /Authentication required/)
      assert.match(error.message, /no prompt was sent/)
      artifactDirectory = error.artifactDirectory
      return true
    })
    assert.equal(typeof artifactDirectory, 'string')
    assert.ok((await lstat(path.join(dir, markerName))).isFile(), 'profile kept after a failed run')
  } finally {
    if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true })
    await close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a complete fixture turn reports only model, effort and fast, and nulls anything not returned', { timeout: 60000 }, async () => {
  const root = await tempRoot()
  const { fixture, url, close } = await startFixture()
  const dir = await createPerfProfile(path.join(root, 'profile'))
  const directories = []
  try {
    const first = await run({ url, headless: true, timeoutMs: 30000, prompt: 'synthetic', profileDirectory: dir })
    directories.push(first.artifactDirectory)
    assert.equal(first.status, 'success')
    assert.equal(first.sessionId, sessionId)
    assert.deepEqual(first.context, {
      model: 'fixture-model', reasoningEffort: 'low', fast: true,
      viewport: { width: 1440, height: 1000, dpr: 1 }, history: 'new-chat', capture: 'headless', startBoundary: 'handler',
    })
    assert.deepEqual(JSON.parse(await readFile(path.join(first.artifactDirectory, 'summary.json'), 'utf8')).context, first.context)
    // Second run reuses the same owned profile. A blank setting is the chat's "no preference"
    // (the server default applies); a missing or malformed one stays null.
    fixture.model = { model: '', effort: 7, fast: 'maybe' }
    const second = await run({ url, headless: true, timeoutMs: 30000, prompt: 'synthetic', profileDirectory: dir })
    directories.push(second.artifactDirectory)
    assert.equal(second.status, 'success')
    assert.deepEqual(second.context, { ...first.context, model: 'default', reasoningEffort: null, fast: null })
    assert.ok((await lstat(path.join(dir, markerName))).isFile())
  } finally {
    for (const directory of directories) if (directory) await rm(directory, { recursive: true, force: true })
    await close()
    await rm(root, { recursive: true, force: true })
  }
})
