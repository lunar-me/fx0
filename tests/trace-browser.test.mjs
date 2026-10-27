import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/lib/trace-browser.ts') && ['./performance-trace', './prompt-trace'].includes(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const browser = await import('../lib/trace-browser.ts')
const sessionId = '00000000-0000-4000-8000-000000000001'
const previewSessionId = '00000000-0000-4000-8000-000000000002'
const testWindow = { location: { hostname: 'localhost' } }

// Each test restores the window and both opt-in flags exactly as they were before it started.
function restoreAfter(t) {
  const oldWindow = globalThis.window
  const previous = {
    trace: process.env.NEXT_PUBLIC_FX0_TRACE,
    scope: process.env.NEXT_PUBLIC_FX0_TRACE_SCOPE,
  }
  t.after(() => {
    globalThis.window?.__fx0Trace?.clear()
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
    setEnv('NEXT_PUBLIC_FX0_TRACE', previous.trace)
    setEnv('NEXT_PUBLIC_FX0_TRACE_SCOPE', previous.scope)
  })
}

// `null` unsets a flag, which is how a deployment without the variable looks.
function useWindow(hostname, { trace = '1', scope = null } = {}) {
  testWindow.location.hostname = hostname
  globalThis.window = testWindow
  setEnv('NEXT_PUBLIC_FX0_TRACE', trace)
  setEnv('NEXT_PUBLIC_FX0_TRACE_SCOPE', scope)
}

function setEnv(name, value) {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}

function eventCount() {
  return testWindow.__fx0Trace?.snapshot().traceEvents.length ?? 0
}

test('browser recording requires both opt-in and a loopback hostname', t => {
  restoreAfter(t)
  useWindow('fx0.example')
  assert.equal(browser.browserTraceEnabled(), false)
  assert.equal(browser.beginBrowserPrompt(sessionId), undefined)
  browser.traceBrowser('prompt.send')()
  assert.equal(globalThis.window.__fx0Trace, undefined)
  globalThis.window.location.hostname = 'localhost'
  process.env.NEXT_PUBLIC_FX0_TRACE = '0'
  assert.equal(browser.browserTraceEnabled(), false)
  assert.equal(browser.beginBrowserPrompt(sessionId), undefined)
})

test('absent or local scope records on loopback hosts only', t => {
  restoreAfter(t)
  for (const scope of [null, 'local']) {
    for (const hostname of ['localhost', '127.0.0.1', '127.10.0.254', '[::1]', '::1']) {
      useWindow(hostname, { scope })
      assert.equal(browser.browserTraceEnabled(), true, `${scope} ${hostname}`)
    }
    useWindow('fx0-pr33.labs.vercel.dev', { scope })
    assert.equal(browser.browserTraceEnabled(), false, `${scope} preview host`)
  }
})

test('preview scope is off without the opt-in flag', t => {
  restoreAfter(t)
  useWindow('fx0-pr33.labs.vercel.dev', { trace: null, scope: 'preview' })
  assert.equal(browser.browserTraceEnabled(), false)
  useWindow('fx0-pr33.labs.vercel.dev', { trace: '0', scope: 'preview' })
  assert.equal(browser.browserTraceEnabled(), false)
  assert.equal(browser.beginBrowserPrompt(previewSessionId), undefined)
  assert.equal(eventCount(), 0)
})

test('preview scope allows only fx0 preview deployments on labs or vercel.app', t => {
  restoreAfter(t)
  for (const hostname of ['fx0-pr33.labs.vercel.dev', 'fx0-my-branch-team.labs.vercel.dev', 'fx0-web-git-branch-team.vercel.app']) {
    useWindow(hostname, { scope: 'preview' })
    assert.equal(browser.browserTraceEnabled(), true, hostname)
  }
  for (const hostname of [
    'localhost', '127.0.0.1', 'fx0.labs.vercel.dev', 'app-fx0-pr33.labs.vercel.dev', 'fx0-.vercel.app',
    'fx0-pr33.labs.vercel.dev.evil.example', 'fx0-pr33.vercel.app.evil.example', 'evil-fx0-pr33.vercel.app',
    'fx0-pr33.vercel.dev', 'preview.labs.vercel.dev', 'vercel.app', 'fx0-pr33.example.com',
  ]) {
    useWindow(hostname, { scope: 'preview' })
    assert.equal(browser.browserTraceEnabled(), false, hostname)
  }
})

test('production and unrecognized scopes stay off on every host', t => {
  restoreAfter(t)
  for (const scope of ['production', 'prod', 'PREVIEW', 'all', '']) {
    for (const hostname of ['localhost', 'fx0-pr33.labs.vercel.dev', 'fx0-web.vercel.app']) {
      useWindow(hostname, { scope })
      assert.equal(browser.browserTraceEnabled(), false, `${scope} ${hostname}`)
    }
  }
})

test('prompt, turn and revision correlation does not assign a queued prompt to the active preview', t => {
  restoreAfter(t)
  useWindow('localhost')
  const first = browser.beginBrowserPrompt(sessionId)
  assert.match(first, /^[a-f0-9]{32}$/)
  browser.correlateBrowserEvent(sessionId, { type: 'user', id: 1 }, first)
  browser.correlateBrowserEvent(sessionId, { type: 'turn_start', id: 1, turnId: 1 })
  const second = browser.beginBrowserPrompt(sessionId)
  browser.correlateBrowserEvent(sessionId, { type: 'user', id: 2 }, second)
  assert.equal(browser.browserTraceContext(sessionId).traceId, first)
  assert.equal(browser.browserTraceContext(sessionId, 2).traceId, second)
  browser.correlateBrowserEvent(sessionId, { type: 'artifact', turnId: 1, artifactRevision: 1 })
  browser.correlateBrowserEvent(sessionId, { type: 'turn_start', id: 2, turnId: 2 })
  assert.equal(browser.browserTraceContext(sessionId).traceId, second)
  assert.equal(browser.browserPreviewContext(sessionId, 1).traceId, first)
  browser.traceBrowser('draft.patch', browser.browserTraceContext(sessionId), { chars: 100 })()
  assert.equal(window.__fx0Trace.snapshot().traceEvents.at(-1).args.traceId, second)
  window.__fx0Trace.clear()
  assert.equal(window.__fx0Trace.snapshot().traceEvents.length, 0)
  assert.equal(browser.browserTraceContext(sessionId).traceId, undefined)
})

test('a real recorder keeps the E2E root open across disconnect and until the final preview', t => {
  restoreAfter(t)
  useWindow('localhost')
  const traceId = browser.beginBrowserPrompt(undefined, 'e2e-client')
  browser.acknowledgeBrowserPrompt(traceId)
  const deliver = item => {
    browser.correlateBrowserEvent(sessionId, item)
    browser.observeBrowserPromptEvent(sessionId, item)
  }
  deliver({ type: 'user', id: 1, clientId: 'e2e-client', seq: 1 })
  deliver({ type: 'text', turnId: 1, delta: 'Synthetic answer', seq: 2 })
  deliver({ type: 'error', text: 'Connection lost' })
  assert.equal(window.__fx0Trace.snapshot().traceEvents.some(event => event.name === 'prompt.e2e'), false)
  deliver({ type: 'artifact', turnId: 1, artifactRevision: 2, seq: 3 })
  deliver({ type: 'done', id: 1, turnId: 1, seq: 4 })
  assert.equal(window.__fx0Trace.snapshot().traceEvents.filter(event => event.name === 'prompt.turn').length, 1)
  assert.equal(window.__fx0Trace.snapshot().traceEvents.some(event => event.name === 'prompt.e2e'), false)
  browser.presentBrowserPreview(sessionId, 1)
  assert.equal(window.__fx0Trace.snapshot().traceEvents.some(event => event.name === 'prompt.e2e'), false)
  assert.equal(browser.browserPreviewContext(sessionId, 2).traceId, undefined, 'GET may deliver the revision before POST binds its trace ID')
  browser.presentBrowserPreview(sessionId, 2)
  const events = window.__fx0Trace.snapshot().traceEvents
  const root = events.find(event => event.name === 'prompt.e2e')
  assert.equal(root.args.traceId, traceId)
  assert.equal(root.args.revision, 2)
  assert.ok(root.dur >= 0)
  assert.equal(events.find(event => event.name === 'prompt.finished').args.seq, 4)
  assert.equal(events.find(event => event.name === 'prompt.finished').args.sessionId, sessionId)
  // Roots carry identifiers and counts only, never streamed answer or error text.
  const json = JSON.stringify(window.__fx0Trace.snapshot())
  assert.doesNotMatch(json, /Synthetic answer/)
  assert.doesNotMatch(json, /Connection lost/)
})

test('preview scope closes the E2E root only at the final presented revision', t => {
  restoreAfter(t)
  useWindow('fx0-pr33.labs.vercel.dev', { scope: 'preview' })
  const traceId = browser.beginBrowserPrompt(previewSessionId, 'preview-client')
  browser.acknowledgeBrowserPrompt(traceId)
  const deliver = item => {
    browser.correlateBrowserEvent(previewSessionId, item)
    browser.observeBrowserPromptEvent(previewSessionId, item)
  }
  deliver({ type: 'user', id: 1, clientId: 'preview-client', seq: 1 })
  deliver({ type: 'artifact', turnId: 1, artifactRevision: 1, seq: 2 })
  deliver({ type: 'done', id: 1, turnId: 1, seq: 3 })
  browser.presentBrowserPreview(previewSessionId, 1)
  const root = window.__fx0Trace.snapshot().traceEvents.find(event => event.name === 'prompt.e2e')
  assert.equal(root.args.traceId, traceId)
  assert.equal(root.args.revision, 1)
})

test('a POST binds a new server-created chat without storing prompt or draft content', t => {
  restoreAfter(t)
  useWindow('localhost')
  const traceId = browser.beginBrowserPrompt()
  const context = browser.correlateBrowserEvent(sessionId, { type: 'user', id: 1, text: 'private prompt' }, traceId)
  browser.traceBrowserEvent('sse.receive', context, { chars: 10 })
  assert.equal(context.traceId, traceId)
  const json = JSON.stringify(window.__fx0Trace.snapshot())
  assert.doesNotMatch(json, /private prompt/)
  assert.match(json, new RegExp(traceId))
})

test('disabled preview scope does not record presentation or prompt state', t => {
  restoreAfter(t)
  useWindow('fx0-pr33.labs.vercel.dev', { scope: 'preview' })
  const traceId = browser.beginBrowserPrompt(previewSessionId)
  assert.match(traceId, /^[a-f0-9]{32}$/)
  const before = eventCount()
  useWindow('fx0-pr33.labs.vercel.dev', { scope: 'production' })
  assert.equal(browser.browserTraceEnabled(), false)
  assert.equal(browser.beginBrowserPrompt(previewSessionId), undefined)
  assert.equal(browser.browserTraceContext(previewSessionId), undefined)
  browser.traceBrowserEvent('preview.presented', undefined, { revision: 1 })
  browser.presentBrowserPreview(previewSessionId, 1)
  browser.traceBrowser('draft.patch', undefined, { chars: 10 })()
  assert.equal(eventCount(), before)
})
