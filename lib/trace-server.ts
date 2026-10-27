import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
// @ts-expect-error Node strip-types tests require the source extension.
import { createTraceRecorder, validTraceId, type TraceContext, type TraceName, type TraceNumbers } from './performance-trace.ts'

// local: a developer machine (FX0_TRACE=1), batched into .next files.
// preview: an opted-in Vercel preview (FX0_TRACE_PREVIEW=1), exported to the function log.
// Production is never traced.
export type ServerTraceMode = 'local' | 'preview'

export function serverTraceMode(): ServerTraceMode | null {
  if (process.env.VERCEL_ENV === 'production') return null
  if (!process.env.VERCEL) return process.env.FX0_TRACE === '1' ? 'local' : null
  return process.env.FX0_TRACE_PREVIEW === '1' && process.env.VERCEL_ENV === 'preview' ? 'preview' : null
}

export function serverTraceEnabled(): boolean {
  return serverTraceMode() != null
}

type Recorder = ReturnType<typeof createTraceRecorder>
interface TraceState {
  recorder: Recorder
  context: AsyncLocalStorage<TraceContext>
  turns: Map<string, TraceContext>
  flushing?: Promise<void>
  warned?: boolean
}
const globalTrace = globalThis as typeof globalThis & { __fx0PerformanceTrace?: TraceState }
const noop = (_attrs?: TraceNumbers) => {}

function state(): TraceState | undefined {
  const mode = serverTraceMode()
  if (!mode) return
  if (!globalTrace.__fx0PerformanceTrace) {
    // PIDs repeat across Vercel function instances, so a preview names its lane with a random per-process id.
    const lane = mode === 'preview' ? `server:${randomUUID()}` : `server:${process.pid}`
    globalTrace.__fx0PerformanceTrace = {
      recorder: createTraceRecorder({ enabled: true, process: lane, capacity: 10_000 }),
      context: new AsyncLocalStorage<TraceContext>(), turns: new Map(),
    }
    // Local batches flush on a timer, best-effort, off the prompt's acknowledgement path. A
    // preview has no timer: a Vercel function can freeze right after its response.
    if (mode === 'local') {
      const timer = setInterval(() => { void flushServerTrace() }, 250)
      timer.unref()
    }
  }
  return globalTrace.__fx0PerformanceTrace
}

// A preview's completed records leave as one JSON line tagged 'fx0:trace', at each span end
// or instant event, so a log collector can parse it. The recorder's allowlists decide the
// payload; nothing is written to disk. Logging is best-effort: a failed write must never
// reach the request, and a missing line only leaves the report incomplete.
function exportPreview(current: TraceState): void {
  try {
    const batch = current.recorder.drain()
    if (batch.traceEvents.length || batch.dropped) console.info(JSON.stringify({ event: 'fx0:trace', ...batch }))
  } catch {
    // Deliberately silent: the request outcome does not depend on diagnostics.
  }
}

export function serverTraceContext(sessionId: string, turnId?: number): TraceContext {
  const current = state()
  const bound = turnId == null ? undefined : current?.turns.get(`${sessionId}:${turnId}`)
  return { ...(bound ?? current?.context.getStore()), sessionId, ...(turnId == null ? {} : { turnId }) }
}

// Correlation is process-local. Session and turn IDs still join recovery traces
// after a restart; tracing adds no persistent data to the durable conversation.
export function bindPromptTrace(sessionId: string, turnId: number): void {
  const current = state()
  if (!current) return
  const key = `${sessionId}:${turnId}`
  current.turns.delete(key)
  current.turns.set(key, { ...current.context.getStore(), sessionId, turnId })
  if (current.turns.size > 256) current.turns.delete(current.turns.keys().next().value!)
}

export function traceServer(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): (attrs?: TraceNumbers) => void {
  const current = state()
  if (!current) return noop
  const end = current.recorder.start(name, context ?? current.context.getStore(), attrs)
  if (serverTraceMode() !== 'preview') return end
  return (result) => { end(result); exportPreview(current) }
}

export function traceServerEvent(name: TraceName, context?: TraceContext, attrs?: TraceNumbers): void {
  const current = state()
  if (!current) return
  current.recorder.instant(name, context ?? current.context.getStore(), attrs)
  if (serverTraceMode() === 'preview') exportPreview(current)
}

export function traceAsync<T>(name: TraceName, context: TraceContext | undefined, work: () => Promise<T>, attrs?: TraceNumbers): Promise<T> {
  // Preserve the original promise path when tracing is off.
  if (!serverTraceEnabled()) return work()
  const end = traceServer(name, context, attrs)
  return (async () => {
    try { return await work() } catch (error) { end({ failed: true }); throw error } finally { end() }
  })()
}

export function runRequestTrace<T>(request: Request, work: () => Promise<T>): Promise<T> {
  const current = state()
  if (!current) return work()
  const incoming = request.headers.get('x-fx0-trace')
  const traceId = validTraceId(incoming) ? incoming : randomUUID().replaceAll('-', '')
  return current.context.run({ traceId }, () => traceAsync('request.handle', undefined, work))
}

export function serverTraceSnapshot() {
  return globalTrace.__fx0PerformanceTrace?.recorder.snapshot() ?? { traceEvents: [], displayTimeUnit: 'ms', dropped: 0 }
}

export async function flushServerTrace(): Promise<void> {
  const current = globalTrace.__fx0PerformanceTrace
  if (!current) return
  const mode = serverTraceMode()
  // A preview exports on every span end; only a local run writes files.
  if (mode === 'preview') {
    exportPreview(current)
    return
  }
  if (mode !== 'local') return
  if (current.flushing) return current.flushing
  // Drain only once per batch; failures lose diagnostic events, never product work.
  const batch = current.recorder.drain()
  if (!batch.traceEvents.length && !batch.dropped) return
  current.flushing = (async () => {
    try {
      const directory = path.join(process.cwd(), '.next', 'fx0-traces')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(path.join(directory, `server-${process.pid}.jsonl`), `${JSON.stringify(batch)}\n`, { mode: 0o600 })
    } catch {
      if (!current.warned) {
        current.warned = true
        console.warn('[fx0] local performance trace could not be written')
      }
    }
  })().finally(() => { current.flushing = undefined })
  return current.flushing
}
