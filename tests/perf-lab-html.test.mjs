import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareRuns, createRun } from '../scripts/lib/perf-lab-data.mjs'
import { renderComparison, renderRun } from '../scripts/lib/perf-lab-html.mjs'
import { launchChrome } from './fixtures/chrome-cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sampleDir = path.join(here, '..', '.next', 'fx0-perf', 'manual-32c447c3')
const samplePresent = existsSync(path.join(sampleDir, 'browser.json')) && existsSync(path.join(sampleDir, 'server.json'))
const skipSample = samplePresent ? false : 'captured sample not present in .next/fx0-perf/manual-32c447c3'
const skipHeadless = process.env.FX0_PERF_LAB_HEADLESS === '1' && samplePresent ? false : 'set FX0_PERF_LAB_HEADLESS=1 to run headless Chrome'

const RECORDED = '2026-10-26T20:20:00.000Z'
const CONDITION = {
  environment: 'local-development', durability: 'local-file', condition: 'unknown', workload: 'reply-ok',
  workloadHash: null, model: 'unknown', reasoningEffort: 'unknown', fast: null, accountHash: null, teamHash: null,
  viewport: null, revision: null, sourceHash: null, instrumentation: 'fx0-trace-v1', history: 'new-chat',
  capture: 'manual', startBoundary: 'handler',
}
const digest = char => char.repeat(64)
const hex = number => String(number).padStart(32, '0')
// Fully specified metadata: every setting known so only the variable under test can differ.
const COMPARABLE = {
  ...CONDITION, condition: 'warm', model: 'gpt-test', reasoningEffort: 'low', workloadHash: digest('1'),
  accountHash: digest('2'), teamHash: digest('3'), viewport: { width: 1440, height: 1000, dpr: 1 },
  revision: 'abcdef1', sourceHash: digest('4'), fast: false,
}

let sampleCache
function sampleTexts() {
  sampleCache ??= Promise.all(['browser.json', 'server.json'].map(name => readFile(path.join(sampleDir, name), 'utf8')))
    .then(([browser, server]) => ({
      browser,
      server,
      original: JSON.parse(browser).traceEvents.find(event => event.name === 'prompt.started').args.traceId,
    }))
  return sampleCache
}

// Real captured browser and server batches, optionally re-keyed to a new traceId so several runs can share one sample.
async function sampleRun({ traceId, label = 'manual-32c447c3', pairId = null, metadata = CONDITION } = {}) {
  const { browser, server, original } = await sampleTexts()
  const swap = text => (traceId ? text.replaceAll(original, traceId) : text)
  return createRun({
    browser: JSON.parse(swap(browser)), server: JSON.parse(swap(server)),
    metadata, label, pairId, recordedAt: RECORDED,
  })
}

const count = (html, pattern) => html.match(pattern)?.length ?? 0

test('renderRun emits one offline document whose only script is CSP-hashed', { skip: skipSample }, async () => {
  const html = renderRun(await sampleRun())
  assert.match(html, /^<!doctype html>/u)
  const [, script] = html.match(/<script>([\s\S]*?)<\/script>/u)
  const hash = createHash('sha256').update(script).digest('base64')
  assert.ok(html.includes(`'sha256-${hash}'`), 'CSP script hash matches the inline script')
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/u)
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|WebSocket|import\(|innerHTML|insertAdjacentHTML|outerHTML|document\.write/u)
})

test('no external assets, fonts, network URLs, or media in the document', { skip: skipSample }, async () => {
  const html = renderRun(await sampleRun())
  assert.doesNotMatch(html, /<(?:link|iframe|img|object|embed|video|audio)\b/iu)
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/iu)
  // Scoped to the stylesheet: the script's own URL.createObjectURL call is not an asset reference.
  const style = html.match(/<style>([\s\S]*?)<\/style>/u)[1]
  assert.doesNotMatch(style, /@import|@font-face|url\(|src:/iu)
  assert.doesNotMatch(html, /https?:\/\//iu)
})

test('hostile labels, ids, names, and metadata stay escaped in markup and JSON payloads', { skip: skipSample }, async () => {
  const base = await sampleRun()
  const evil = '</script><img src=x onerror=alert(1)>\u2028\u2029'
  const run = {
    ...base,
    label: '<img src=x onerror=alert(1)>',
    pairId: '"><svg onload=alert(1)>',
    issues: ['<b>x</b>'],
    metadata: { ...base.metadata, workload: evil, model: '<i>m</i>' },
    trace: { ...base.trace, traceEvents: base.trace.traceEvents.map((event, index) => (index === 0 ? { ...event, name: evil } : event)) },
  }
  const html = renderRun(run)
  assert.doesNotMatch(html, /<img\b|<svg\b|<b>x<\/b>|<i>m<\/i>/iu)
  assert.equal(count(html, /<script\b/giu), count(html, /<\/script>/giu), 'every script element is closed exactly once')
  assert.ok(!html.includes('\u2028') && !html.includes('\u2029'), 'line separators are escaped')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u)
  assert.ok(html.includes('\\u003c/script\\u003e'), 'JSON payload escapes markup')
})

test('invalid trace events are dropped and counted, never rendered', { skip: skipSample }, async () => {
  const base = await sampleRun()
  const junk = [
    { name: 'prompt.send', ph: 'X', ts: -1, dur: 1, pid: 'browser', args: {} },
    { name: 'prompt.send', ph: 'B', ts: 5, pid: 'browser', args: {} },
    { name: 'prompt.send', ph: 'X', ts: 'soon', dur: 1, pid: 'browser', args: {} },
    { name: 'prompt.send', ph: 'X', ts: 5, pid: 'evil lane', dur: 1, args: {} },
    { name: 'prompt.send', ph: 'X', ts: 5, dur: Number.NaN, pid: 'browser', args: {} },
    { name: 'prompt.send', ph: 'X', ts: 5, pid: 'browser', args: {} },
  ]
  // A valid instant whose disallowed argument must be dropped while the event itself stays.
  const kept = { name: 'sse.receive', ph: 'i', ts: base.trace.traceEvents[0].ts, pid: 'browser', args: { prompt: 'PRIVATE PROMPT' } }
  const html = renderRun({ ...base, trace: { ...base.trace, traceEvents: [...base.trace.traceEvents, ...junk, kept] } })
  assert.match(html, /Invalid events dropped by renderer<\/dt><dd>6<\/dd>/u)
  assert.equal(count(html, /\sdata-event[\s>]/gu), base.trace.traceEvents.length + 1)
  assert.doesNotMatch(html, /PRIVATE PROMPT|evil lane/u)
})

test('null metrics and unrecorded milestones render as unknown, never zero', { skip: skipSample }, async () => {
  const base = await sampleRun()
  const allNull = { ...base, status: 'incomplete', metrics: Object.fromEntries(Object.keys(base.metrics).map(key => [key, null])) }
  const html = renderRun(allNull)
  for (const key of Object.keys(base.metrics)) {
    assert.match(html, new RegExp(`data-metric="${key}"><td>[^<]*</td><td>unknown</td>`, 'u'), key)
  }
  assert.match(renderRun(base), /data-metric="previewMs"><td>[^<]*<\/td><td>unknown<\/td>/u)
  assert.ok(renderRun(base).includes(`${base.metrics.firstTextMs.toFixed(3)} ms`), 'recorded metric keeps its exact value')
  const noText = { ...base, trace: { ...base.trace, traceEvents: base.trace.traceEvents.filter(event => event.name !== 'prompt.first_content') } }
  assert.match(renderRun(noText), /Send handler to first text received<\/span><div class="bar"><\/div><span>unknown<\/span>/u)
  assert.match(renderRun(noText), /Missing browser milestones<\/dt><dd>prompt\.first_content<\/dd>/u)
})

test('incompatible comparisons name reason codes and show no deltas', { skip: skipSample }, async () => {
  const baseline = await sampleRun({ traceId: hex(1), label: 'baseline-1', pairId: '1', metadata: COMPARABLE })
  const candidate = await sampleRun({ traceId: hex(2), label: 'candidate-1', pairId: '1', metadata: { ...COMPARABLE, model: 'gpt-other' } })
  const comparison = compareRuns([baseline], [candidate])
  assert.equal(comparison.compatible, false)
  assert.deepEqual(comparison.reasons, ['model_mismatch'])
  const html = renderComparison(comparison, { baselineRuns: [baseline], candidateRuns: [candidate] })
  assert.match(html, /not comparable/iu)
  assert.match(html, /<code>model_mismatch<\/code>/u)
  assert.doesNotMatch(html, /class="(?:pos|neg)"|Improvement|Paired/u)
})

test('unknown settings make a default run comparison incompatible without deltas', { skip: skipSample }, async () => {
  const baseline = await sampleRun({ traceId: hex(3), pairId: '1' })
  const candidate = await sampleRun({ traceId: hex(4), pairId: '1' })
  const comparison = compareRuns([baseline], [candidate])
  assert.equal(comparison.compatible, false)
  assert.ok(comparison.reasons.includes('condition_unknown'))
  const html = renderComparison(comparison, { baselineRuns: [baseline], candidateRuns: [candidate] })
  assert.match(html, /<code>condition_unknown<\/code>/u)
  assert.match(html, /Not comparable: deltas, improvement, and the metric table are hidden/u)
  assert.doesNotMatch(html, /<th>Improvement<\/th>/u)
})

test('A/A control and small samples are labeled as noise and descriptive, not proof', { skip: skipSample }, async () => {
  const baselineRuns = []
  const candidateRuns = []
  for (let index = 1; index <= 3; index++) {
    baselineRuns.push(await sampleRun({ traceId: hex(10 + index), label: `baseline-${index}`, pairId: String(index), metadata: COMPARABLE }))
    candidateRuns.push(await sampleRun({ traceId: hex(20 + index), label: `candidate-${index}`, pairId: String(index), metadata: COMPARABLE }))
  }
  const comparison = compareRuns(baselineRuns, candidateRuns)
  assert.equal(comparison.compatible, true)
  assert.equal(comparison.control, true)
  assert.equal(comparison.smallSample, true)
  const html = renderComparison(comparison, { baselineRuns, candidateRuns })
  assert.match(html, /A\/A control: differences are noise, not speedup/u)
  assert.match(html, /small sample: descriptive, not proof/u)
  assert.match(html, /<td class="neutral">[^<]*%<\/td>/u)
  assert.doesNotMatch(html, /class="(?:pos|neg)"/u)
  assert.match(html, /data-metric="firstTextMs"/u)

  const other = candidateRuns.map(run => ({ ...run, metadata: { ...run.metadata, sourceHash: digest('5') } }))
  const real = compareRuns(baselineRuns, other)
  assert.equal(real.control, false)
  assert.equal(real.smallSample, true)
  const notControl = renderComparison(real, { baselineRuns, candidateRuns: other })
  assert.doesNotMatch(notControl, /A\/A control/u)
  assert.match(notControl, /small sample/u)
})

test('renderComparison lists every supplied run and shows only the selected panel per side', { skip: skipSample }, async () => {
  const baselineRuns = [await sampleRun({ traceId: hex(30), label: 'baseline-a', pairId: '1', metadata: COMPARABLE }),
    await sampleRun({ traceId: hex(31), label: 'baseline-b', pairId: '2', metadata: COMPARABLE })]
  const candidateRuns = [await sampleRun({ traceId: hex(32), label: 'candidate-a', pairId: '1', metadata: COMPARABLE }),
    await sampleRun({ traceId: hex(33), label: 'candidate-b', pairId: '2', metadata: COMPARABLE })]
  const comparison = compareRuns(baselineRuns, candidateRuns)
  const html = renderComparison(comparison, { baselineRuns, candidateRuns })
  const panels = html.match(/<section class="run" data-run data-side="\w+" data-index="\d+"( hidden)?>/gu) ?? []
  assert.equal(panels.length, 4)
  assert.equal(panels.filter(panel => panel.includes(' hidden')).length, 2)
  assert.match(html, /<option value="0" selected>baseline-a/u)
  assert.match(renderComparison(comparison), /no runs supplied/u)
})

test('run downloads embed the core Chrome export with numeric lanes', { skip: skipSample }, async () => {
  const html = renderRun(await sampleRun())
  assert.match(html, /data-download="dl-run-run"/u)
  assert.match(html, /data-download="dl-run-chrome"/u)
  const payload = html.match(/<script type="application\/json" id="dl-run-chrome">([\s\S]*?)<\/script>/u)[1]
  const chrome = JSON.parse(payload)
  assert.ok(chrome.traceEvents.some(event => event.name === 'process_name'))
  assert.ok(chrome.traceEvents.every(event => Number.isInteger(event.pid)))
})

test('renderers reject non-objects and the module imports no filesystem or network APIs', async () => {
  assert.throws(() => renderRun(null), TypeError)
  assert.throws(() => renderComparison(null), TypeError)
  assert.throws(() => renderComparison({}, { baselineRuns: 'x' }), TypeError)
  const source = await readFile(path.join(here, '..', 'scripts', 'lib', 'perf-lab-html.mjs'), 'utf8')
  assert.doesNotMatch(source, /from 'node:(?:fs|fs\/promises|net|http|https|dns|tls)'|\bfetch\(|XMLHttpRequest/u)
  assert.match(source, /from 'node:crypto'/u)
})

test('headless Chrome: hover, pin, filter, zoom, and the Chrome-trace download run under the CSP', { skip: skipHeadless, timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fx0-perf-lab-'))
  const downloads = path.join(dir, 'downloads')
  await mkdir(downloads)
  const file = path.join(dir, 'report.html')
  await writeFile(file, renderRun(await sampleRun()))
  const browser = await launchChrome({ headless: true, timeoutMs: 20000 })
  try {
    const { cdp } = browser
    await cdp.send('Page.enable')
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await cdp.send('Page.navigate', { url: pathToFileURL(file).href })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await cdp.evaluate(`document.querySelectorAll('[data-event]').length > 0`)) break
      await delay(100)
    }
    const total = await cdp.evaluate(`document.querySelectorAll('[data-event]').length`)
    assert.ok(total > 0)
    assert.equal(await cdp.evaluate(`document.querySelectorAll('img,iframe,link,script[src]').length`), 0)

    const hovered = await cdp.evaluate(`(() => {
      const el = document.querySelector('.span')
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      return [el.dataset.readable, document.querySelector('[data-details]').textContent]
    })()`)
    assert.ok(hovered[1].includes(hovered[0]) && hovered[1].includes('Raw trace name'))

    const pinned = await cdp.evaluate(`(() => {
      const el = document.querySelector('.span')
      el.click()
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      const kept = document.querySelector('[data-details]').textContent.includes(el.dataset.readable)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return [kept, document.querySelector('[data-details]').textContent]
    })()`)
    assert.equal(pinned[0], true)
    assert.match(pinned[1], /Hover or focus an event/u)

    const filtered = await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-filter]')
      input.value = 'sse'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return [document.querySelectorAll('[data-event]:not([hidden])').length, document.querySelector('[data-count]').textContent]
    })()`)
    assert.ok(filtered[0] > 0 && filtered[0] < total)
    assert.match(filtered[1], /events shown/u)

    const ratio = await cdp.evaluate(`(() => {
      const range = document.querySelector('[data-zoom-range]')
      range.value = '100'
      range.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelector('.track').getBoundingClientRect().width / document.querySelector('.scroll').clientWidth
    })()`)
    assert.ok(ratio > 50, `zoomed track is wide (ratio ${ratio})`)

    await cdp.evaluate(`document.querySelector('a[data-download="dl-run-chrome"]').click()`)
    let saved
    for (let attempt = 0; attempt < 100 && !saved; attempt++) {
      saved = (await readdir(downloads)).find(name => name.endsWith('-chrome.json'))
      if (!saved) await delay(100)
    }
    assert.ok(saved, 'Chrome trace downloaded')
    const chrome = JSON.parse(await readFile(path.join(downloads, saved), 'utf8'))
    assert.ok(chrome.traceEvents.every(event => Number.isInteger(event.pid)))
  } finally {
    await browser.close()
    await rm(dir, { recursive: true, force: true })
  }
})
