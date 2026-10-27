import { createTraceRecorder, type TraceContext, type TraceName, type TraceNumbers } from './performance-trace'
import type { StreamItem } from './events'
import { createPromptTrace } from './prompt-trace'

const noop = (_attrs?: TraceNumbers) => {}
type Recorder = ReturnType<typeof createTraceRecorder>
let recorder: Recorder | undefined
let promptTimeline: ReturnType<typeof createPromptTrace> | undefined
let observer: PerformanceObserver | undefined
const sessions = new Map<string, TraceContext>()
const turns = new Map<string, TraceContext>()
const revisions = new Map<string, TraceContext>()

// Correlation is ephemeral and bounded too, including after many chats/turns.
function remember(map: Map<string, TraceContext>, key: string, context: TraceContext) {
  map.delete(key)
  map.set(key, context)
  if (map.size > 256) map.delete(map.keys().next().value!)
}

export function browserTraceEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_FX0_TRACE !== '1' || typeof window === 'undefined') return false
  const hostname = window.location.hostname
  // An absent scope keeps the original loopback-only default. Preview is an explicit
  // opt-in; any other scope (including 'production') records nothing.
  const scope = process.env.NEXT_PUBLIC_FX0_TRACE_SCOPE
  if (scope === undefined || scope === 'local') return isLoopbackHost(hostname)
  if (scope === 'preview') return isFx0PreviewHost(hostname)
  return false
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname)
}

// Only fx0 preview deployments: fx0-<name>.labs.vercel.dev or fx0-<name>.vercel.app.
function isFx0PreviewHost(hostname: string): boolean {
  return /^fx0-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:labs\.vercel\.dev|vercel\.app)$/.test(hostname)
}

declare global {
  interface Window {
    __fx0Trace?: {
      snapshot: Recorder['snapshot']
      download: () => void
      clear: () => void
    }
  }
}

function getRecorder(): Recorder | undefined {
  if (!browserTraceEnabled()) return
  if (!recorder) {
    recorder = createTraceRecorder({ enabled: true, process: 'browser', capacity: 10_000 })
    promptTimeline = createPromptTrace(recorder)
    window.__fx0Trace = {
      snapshot: () => recorder!.snapshot(),
      clear: () => { recorder!.drain(); promptTimeline!.clear(); sessions.clear(); turns.clear(); revisions.clear() },
      download: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(recorder!.snapshot())], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = 'fx0-browser-trace.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 0)
      },
    }
  }
  return recorder
}

export function traceBrowser(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): (attrs?: TraceNumbers) => void {
  return getRecorder()?.start(name, context, attrs) ?? noop
}

export function traceBrowserEvent(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): void {
  getRecorder()?.instant(name, context, attrs)
}

export function beginBrowserPrompt(sessionId?: string, clientId?: string): string | undefined {
  if (!getRecorder()) return
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const traceId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  if (sessionId && !sessions.has(sessionId)) remember(sessions, sessionId, { traceId, sessionId })
  promptTimeline!.begin(traceId, sessionId, clientId)
  return traceId
}

export function observeBrowserPromptEvent(sessionId: string, item: StreamItem): void {
  if (browserTraceEnabled()) promptTimeline?.observe(sessionId, item)
}

export function acknowledgeBrowserPrompt(traceId?: string): void {
  if (browserTraceEnabled() && traceId) promptTimeline?.acknowledged(traceId)
}

// Call only on a definite refusal before admission, never on an SSE disconnect.
export function failBrowserPrompt(traceId?: string, cancelled = false): void {
  if (browserTraceEnabled() && traceId) promptTimeline?.fail(traceId, cancelled)
}

export function presentBrowserPreview(sessionId: string, revision: number): void {
  if (!browserTraceEnabled()) return
  // The root's client/turn join is authoritative even when GET beat POST and the
  // generic revision cache never received that POST's trace ID.
  if (!promptTimeline?.presented(sessionId, revision)) {
    traceBrowserEvent('preview.presented', browserPreviewContext(sessionId, revision), { revision })
  }
}

export function browserTraceContext(sessionId: string, turnId?: number): TraceContext | undefined {
  if (!browserTraceEnabled()) return
  const context = turnId == null ? sessions.get(sessionId) : turns.get(`${sessionId}:${turnId}`)
  return { ...context, sessionId, ...(turnId == null ? {} : { turnId }) }
}

export function correlateBrowserEvent(sessionId: string, item: StreamItem, promptTraceId?: string): TraceContext | undefined {
  if (!browserTraceEnabled()) return
  const turnId = item.turnId ?? ((item.type === 'turn_start' || item.type === 'user' || item.type === 'accepted' || item.type === 'done' || item.type === 'error') ? item.id : undefined)
  const key = turnId == null ? undefined : `${sessionId}:${turnId}`
  const explicit = promptTraceId && (item.type === 'accepted' || item.type === 'user')
  const context = {
    ...(key ? turns.get(key) : undefined) ?? sessions.get(sessionId),
    ...(explicit ? { traceId: promptTraceId } : {}),
    sessionId,
    ...(turnId == null ? {} : { turnId }),
  }
  if (key) remember(turns, key, context)
  // Queued users must not replace the currently running turn's context.
  if (item.type !== 'user' && item.type !== 'accepted') remember(sessions, sessionId, context)
  if (item.type === 'artifact' && item.artifactRevision != null) remember(revisions, `${sessionId}:${item.artifactRevision}`, context)
  return context
}

export function browserPreviewContext(sessionId: string, revision: number): TraceContext | undefined {
  if (!browserTraceEnabled()) return
  return revisions.get(`${sessionId}:${revision}`) ?? browserTraceContext(sessionId)
}

export function initBrowserTracing(): void {
  if (!getRecorder() || observer || typeof PerformanceObserver === 'undefined') return
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  try {
    observer = new PerformanceObserver(list => {
      // The shared API cannot backdate spans. Record occurrences, not fake durations.
      traceBrowserEvent('browser.longtask', undefined, { count: list.getEntries().length })
    })
    observer.observe({ type: 'longtask', buffered: true })
    window.addEventListener('pagehide', () => {
      observer?.disconnect()
      observer = undefined
    }, { once: true })
    window.addEventListener('pageshow', () => { initBrowserTracing() }, { once: true })
  } catch {
    observer?.disconnect()
    observer = undefined
  }
}
