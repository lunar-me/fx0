// fx0 performance lab: capture real prompts, render visual traces, and run paired A/B campaigns.
// Every `run` and `ab` sample sends a LIVE prompt (it may incur model charges). Nothing here
// fakes a model, bypasses authentication, or reads the user's normal Chrome profile.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { createPerfProfile, labTargetUrl, launchChrome } from '../tests/fixtures/chrome-cdp.mjs'
import { run as runPrompt } from './perf-e2e.mjs'
import { loadTraceFiles } from './trace-report.mjs'
import { compareRuns, createRun, makeSchedule } from './lib/perf-lab-data.mjs'
import { renderComparison, renderRun } from './lib/perf-lab-html.mjs'

const help = `Usage: node scripts/perf-lab.mjs <command> [options]

  login     --profile DIR --url URL [--timeout-minutes N (default 15)]
            Create a dedicated fx0 performance profile and sign in once in its own Chrome window.
  run       --profile DIR --url URL --out LAB [--label baseline|candidate] [--pair ID]
            [--source DIR] [--prompt TEXT] [--workload ID] [--condition cold|warm]
            [--environment local-development|local-production] [--durability local-file|vercel]
            One LIVE prompt in headless Chrome, saved as a run with its server trace.
  ab        --profile DIR --out LAB --pairs N --seed S
            --baseline-url URL --baseline-source DIR --candidate-url URL --candidate-source DIR
            [--warmup N (default 1 per side)] [--prompt TEXT] [--workload ID] [--environment ...] [--durability ...]
            Balanced, seeded A/B: 2*N measured LIVE prompts plus warmups. Failures are kept, never retried.
  import    --browser FILE --server FILE|DIR --out LAB [--label L] [--pair ID] [--workload ID]
            [--condition ...] [--environment ...] [--durability ...]
            Save an existing manual capture (unknown settings make it viewable but not comparable).
  report    LAB
            Write LAB/index.html (comparison when both labels exist) and one HTML report per run.
  schedule  --pairs N --seed S
            Print the balanced pair order without sending anything.

Reports are static, offline HTML files: open them in a browser. Spans overlap; never sum them.`

const DEFAULT_PROMPT = 'Reply exactly OK. Do not use tools.'
const run = promisify(execFile)
const sha256 = value => createHash('sha256').update(value).digest('hex')

function parse(args) {
  const [command, ...rest] = args
  const options = { _: [] }
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (!arg.startsWith('--')) { options._.push(arg); continue }
    const value = rest[index + 1]
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    options[arg.slice(2)] = value
    index++
  }
  return { command, options }
}

function required(options, ...names) {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required; see --help`)
}

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value ?? '') || Number(value) < min || Number(value) > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`)
  return Number(value)
}

// Revision plus a hash of every tracked change and untracked, non-ignored file: two worktrees
// running different code get different source hashes; .env files stay ignored and unread.
async function sourceIdentity(directory) {
  const git = (...args) => run('git', ['-C', directory, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' })
  const head = (await git('rev-parse', 'HEAD')).stdout.toString().trim()
  const hash = createHash('sha256').update(head).update((await git('diff', 'HEAD', '--binary')).stdout)
  const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).stdout.toString().split('\0').filter(Boolean).sort()
  for (const file of untracked) {
    if (file === 'node_modules' || file.startsWith('node_modules/')) continue
    hash.update(file).update('\0')
    try { hash.update(await readFile(path.join(directory, file))) } catch { hash.update('<unreadable>') }
  }
  return { revision: head, sourceHash: hash.digest('hex') }
}

// Account and team are recorded as hashes only, read once per campaign through routes the UI uses.
async function identity(profileDirectory, url) {
  const app = labTargetUrl(url).url
  const browser = await launchChrome({ headless: true, profileDirectory })
  try {
    await browser.cdp.send('Page.navigate', { url: app.origin + '/' })
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await browser.cdp.evaluate(`(async () => {
        if (location.origin !== ${JSON.stringify(app.origin)}) return null;
        const me = await (await fetch('/api/auth/me', { cache: 'no-store' })).json();
        if (!me?.user?.id) return { signedIn: false };
        const teams = await fetch('/api/teams', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
        return { signedIn: true, user: String(me.user.id), team: typeof teams?.current === 'string' ? teams.current : null };
      })()`).catch(() => null)
      if (value?.signedIn === false) throw new Error('The performance profile is not signed in; run `login` first. No prompt was sent.')
      if (value?.signedIn) return { accountHash: sha256(`account:${value.user}`), teamHash: value.team ? sha256(`team:${value.team}`) : null }
      await delay(200)
    }
    throw new Error('Could not read the signed-in identity')
  } finally { await browser.close() }
}

function metadataFor(options, { context = {}, identity: who = {}, source = {}, prompt, capture, kind = 'local' }) {
  const known = value => (typeof value === 'string' && value ? value.toLowerCase() : 'unknown')
  return {
    environment: options.environment ?? (kind === 'preview' ? 'vercel-preview' : 'local-development'),
    durability: options.durability ?? (kind === 'preview' ? 'vercel' : 'local-file'),
    condition: options.condition ?? 'unknown',
    workload: options.workload ?? (prompt === DEFAULT_PROMPT ? 'reply-ok' : 'custom'),
    workloadHash: prompt ? sha256(prompt) : null,
    model: known(context.model),
    reasoningEffort: known(context.reasoningEffort),
    fast: typeof context.fast === 'boolean' ? context.fast : null,
    accountHash: who.accountHash ?? null,
    teamHash: who.teamHash ?? null,
    viewport: context.viewport ?? null,
    revision: source.revision ?? null,
    sourceHash: source.sourceHash ?? null,
    instrumentation: 'fx0-trace-v1',
    history: context.history === 'followup' ? 'follow-up' : context.history ?? 'unknown',
    capture,
    startBoundary: 'handler',
  }
}

// Server spans join a run only through the browser root's exact trace id.
async function serverTrace(traceDirectory, traceId) {
  const loaded = await loadTraceFiles([traceDirectory]).catch(() => ({ traceEvents: [], dropped: 0 }))
  return { traceEvents: loaded.traceEvents.filter(event => event.args?.traceId === traceId), displayTimeUnit: 'ms', dropped: loaded.dropped }
}

// A preview's spans arrive through its function logs, a few seconds late. Poll the
// deployment's logs for this exact trace id until its span count stops growing.
async function previewServerTrace(appUrl, traceId, options) {
  const cli = ['vercel', '/opt/homebrew/bin/vercel', '/usr/local/bin/vercel']
  const directory = path.join(tmpdir(), `fx0-perf-logs-${process.pid}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${traceId}.jsonl`)
  let best = { traceEvents: [], displayTimeUnit: 'ms', dropped: 0 }
  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(attempt ? 4000 : 6000)
    let stdout = ''
    for (const binary of cli) {
      try {
        stdout = (await run(binary, ['logs', '--scope', options['vercel-scope'] ?? 'vercel-labs', '--project', options['vercel-project'] ?? 'fx0',
          '--deployment', appUrl.origin, '--since', '30m', '--query', traceId, '--json', '--non-interactive'],
          { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })).stdout
        break
      } catch (error) { if (error.code !== 'ENOENT') break }
    }
    await writeFile(file, stdout.split('\n').filter(line => line.startsWith('{')).join('\n') + '\n', { mode: 0o600 })
    const loaded = await loadTraceFiles([file]).catch(() => ({ traceEvents: [], dropped: 0 }))
    const events = loaded.traceEvents.filter(event => event.args?.traceId === traceId)
    if (events.length && events.length === best.traceEvents.length) return best
    if (events.length >= best.traceEvents.length) best = { traceEvents: events, displayTimeUnit: 'ms', dropped: loaded.dropped }
  }
  return best
}

async function saveRun(lab, runRecord) {
  await mkdir(path.join(lab, 'runs'), { recursive: true, mode: 0o700 })
  const name = `${runRecord.label}-${runRecord.pairId ?? 'x'}-${runRecord.id}.json`
  await writeFile(path.join(lab, 'runs', name), JSON.stringify(runRecord, null, 2) + '\n', { mode: 0o600 })
  return path.join(lab, 'runs', name)
}

// One live prompt. A failed send is saved as a failed run (with whatever trace exists) and never retried.
async function capture(options, { url, source, label, pair, who, sourceId }) {
  const prompt = options.prompt ?? DEFAULT_PROMPT
  let summary
  let artifactDirectory
  try {
    summary = await runPrompt({ url, prompt, timeoutMs: 180000, headless: true, profileDirectory: options.profile })
    artifactDirectory = summary.artifactDirectory
  } catch (error) {
    artifactDirectory = error.artifactDirectory
    if (!artifactDirectory) throw error
    console.error(`Run failed: ${error.message}`)
  }
  const browser = JSON.parse(await readFile(path.join(artifactDirectory, 'trace.json'), 'utf8'))
  const traceId = browser.traceEvents.find(event => event.name === 'prompt.started')?.args?.traceId
  const target = labTargetUrl(url)
  let server = null
  if (traceId && target.kind === 'preview') server = await previewServerTrace(target.url, traceId, options)
  else if (traceId) {
    await delay(800) // local server batches flush every 250 ms
    server = await serverTrace(path.join(source, '.next/fx0-traces'), traceId)
  }
  const context = summary?.context ?? JSON.parse(await readFile(path.join(artifactDirectory, 'summary.json'), 'utf8')).context ?? {}
  const record = createRun({
    browser, server, label, pairId: pair ?? null, recordedAt: new Date().toISOString(),
    metadata: metadataFor(options, { context, identity: who, source: sourceId, prompt, capture: 'headless', kind: target.kind }),
  })
  const file = await saveRun(options.out, record)
  const shown = record.metrics.firstTextMs == null ? record.status : `first text ${record.metrics.firstTextMs} ms, sending ${record.metrics.sendingMs} ms`
  console.log(`${label}${pair ? ` pair ${pair}` : ''}: ${shown} -> ${path.relative(process.cwd(), file)}`)
  return record
}

async function loadRuns(lab) {
  const directory = path.join(lab, 'runs')
  const files = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.json')).sort()
  return Promise.all(files.map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))))
}

async function report(lab) {
  const runs = await loadRuns(lab)
  if (!runs.length) throw new Error('No runs found in this lab directory')
  await mkdir(path.join(lab, 'reports'), { recursive: true, mode: 0o700 })
  for (const item of runs) await writeFile(path.join(lab, 'reports', `${item.label}-${item.pairId ?? 'x'}-${item.id}.html`), renderRun(item), { mode: 0o600 })
  const baselines = runs.filter(item => item.label === 'baseline')
  const candidates = runs.filter(item => item.label === 'candidate')
  let index
  if (baselines.length && candidates.length) {
    const comparison = compareRuns(baselines, candidates)
    index = renderComparison(comparison, { baselineRuns: baselines, candidateRuns: candidates })
    await writeFile(path.join(lab, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { mode: 0o600 })
    console.log(comparison.compatible ? `Compatible: ${comparison.counts.valid} valid pair(s)${comparison.smallSample ? ' (small sample, descriptive only)' : ''}${comparison.control ? ' (A/A control)' : ''}`
      : `Not comparable: ${comparison.reasons.join(', ')}`)
    for (const metric of comparison.metrics) {
      if (metric.pairedDeltaMs == null) continue
      const verdict = comparison.control ? 'A/A noise, not a speedup' : `${metric.improvementPercent}% ${metric.improvementPercent >= 0 ? 'faster' : 'slower'}`
      console.log(`  ${metric.name}: p50 ${metric.baseline.p50} -> ${metric.candidate.p50} ms, paired delta ${metric.pairedDeltaMs} ms (${verdict})`)
    }
  } else index = renderRun(runs.at(-1))
  await writeFile(path.join(lab, 'index.html'), index, { mode: 0o600 })
  console.log(`Report: ${path.resolve(lab, 'index.html')}`)
}

async function login(options) {
  required(options, 'profile', 'url')
  const app = labTargetUrl(options.url).url
  const profileDirectory = await createPerfProfile(options.profile)
  const browser = await launchChrome({ headless: false, profileDirectory })
  try {
    await browser.cdp.send('Page.navigate', { url: app.origin + '/login' })
    const minutes = integer(options['timeout-minutes'] ?? '15', 'timeout-minutes', 1, 60)
    console.log(`Sign in in the new Chrome window (dedicated fx0 profile). Waiting up to ${minutes} minutes...`)
    for (let waited = 0; waited < minutes * 60000; waited += 1000) {
      const signedIn = await browser.cdp.evaluate(`location.origin === ${JSON.stringify(app.origin)} &&
        fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json()).then(me => !!me?.user)`).catch(() => false)
      if (signedIn) { console.log('Signed in. The profile can now run headless.'); return }
      await delay(1000)
    }
    throw new Error(`Sign-in was not completed within ${minutes} minutes`)
  } finally { await browser.close() }
}

async function ab(options) {
  required(options, 'profile', 'out', 'pairs', 'seed', 'baseline-url', 'baseline-source', 'candidate-url', 'candidate-source')
  const pairs = integer(options.pairs, 'pairs', 1, 100)
  const warmup = integer(options.warmup ?? '1', 'warmup', 0, 5)
  const sides = {
    baseline: { url: options['baseline-url'], source: path.resolve(options['baseline-source']) },
    candidate: { url: options['candidate-url'], source: path.resolve(options['candidate-source']) },
  }
  for (const side of Object.values(sides)) {
    labTargetUrl(side.url)
    side.sourceId = await sourceIdentity(side.source)
  }
  if (sides.baseline.sourceId.sourceHash === sides.candidate.sourceId.sourceHash) console.log('Same source on both sides: this is an A/A noise control.')
  const who = await identity(options.profile, sides.baseline.url)
  const settings = { ...options, condition: warmup ? 'warm' : 'cold' }
  console.log(`Sending ${2 * pairs + 2 * warmup} live prompts (${warmup} warmup per side, excluded).`)
  for (const label of ['baseline', 'candidate']) {
    for (let index = 0; index < warmup; index++) {
      await runPrompt({ url: sides[label].url, prompt: options.prompt ?? DEFAULT_PROMPT, timeoutMs: 180000, headless: true, profileDirectory: options.profile })
        .catch(error => console.error(`Warmup ${label} failed: ${error.message}`))
    }
  }
  for (const { pairId, order } of makeSchedule(pairs, options.seed)) {
    for (const label of order) await capture(settings, { ...sides[label], label, pair: pairId, who })
  }
  await report(options.out)
}

export async function main(args = process.argv.slice(2)) {
  const { command, options } = parse(args)
  if (!command || command === '--help' || command === 'help') { console.log(help); return 0 }
  switch (command) {
    case 'login': await login(options); return 0
    case 'schedule':
      required(options, 'pairs', 'seed')
      for (const { pairId, order } of makeSchedule(integer(options.pairs, 'pairs', 1, 100), options.seed)) console.log(`${pairId}: ${order.join(' -> ')}`)
      return 0
    case 'run': {
      required(options, 'profile', 'url', 'out')
      const source = path.resolve(options.source ?? process.cwd())
      await capture(options, { url: options.url, source, label: options.label ?? 'baseline', pair: options.pair,
        who: await identity(options.profile, options.url), sourceId: await sourceIdentity(source) })
      await report(options.out)
      return 0
    }
    case 'ab': await ab(options); return 0
    case 'import': {
      required(options, 'browser', 'server', 'out')
      const browser = JSON.parse(await readFile(options.browser, 'utf8'))
      const traceId = browser.traceEvents?.find(event => event.name === 'prompt.started')?.args?.traceId
      const record = createRun({
        browser, server: traceId ? await serverTrace(options.server, traceId) : null,
        label: options.label ?? 'baseline', pairId: options.pair ?? null, recordedAt: new Date().toISOString(),
        metadata: metadataFor(options, { capture: 'manual', context: { history: 'new-chat' } }),
      })
      console.log(`Imported ${record.status} run -> ${await saveRun(options.out, record)}`)
      await report(options.out)
      return 0
    }
    case 'report': await report(options._[0] ?? options.out ?? '.'); return 0
    default: throw new Error(`Unknown command ${command}; see --help`)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
