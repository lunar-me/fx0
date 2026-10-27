import type { StreamItem } from './events'
import { localEvents, readEvents } from './journal'
import { readDraft, type DraftCursor } from './draft-store'
// @ts-expect-error Node strip-types tests require the source extension.
import { serverTraceContext, traceAsync, traceServer } from './trace-server.ts'

interface EventStreamOptions {
  afterSeq?: number
  // Longest idle gap between journal reads. A prompt's own stream keeps it short so
  // the first token after a long think lands fast; idle chat streams back off further.
  maxIdleMs?: number
  // Ends the stream cleanly after this long, so its function returns before the
  // platform's duration limit kills it. The client reconnects from its last seq.
  maxLifetimeMs?: number
  closeWhen?: (item: StreamItem) => boolean
  wake?: () => void
}

export function createSessionEventStream(sessionId: string, options: EventStreamOptions = {}): ReadableStream<string> {
  let cursor = Math.max(0, options.afterSeq ?? 0)
  let stopped = false
  let pollDelayMs = 100
  let polling = false
  let pollAgain = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let wakeTimer: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  let onLocal: ((item: StreamItem) => void) | null = null
  let onLive: ((item: StreamItem) => void) | null = null
  let draftCursor: DraftCursor | undefined
  let running = false

  const stopTimers = () => {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
    if (heartbeat) clearInterval(heartbeat)
    if (wakeTimer) clearInterval(wakeTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    if (onLocal) localEvents.off(sessionId, onLocal)
    if (onLive) localEvents.off(`${sessionId}:live`, onLive)
  }

  return new ReadableStream<string>({
    start(controller) {
      // Every write goes through here, so nothing is written once the stream has
      // stopped: a closed or cancelled controller throws on enqueue.
      const send = (chunk: string) => {
        if (!stopped) controller.enqueue(chunk)
      }
      const close = () => {
        if (stopped) return
        stopTimers()
        controller.close()
      }
      // Delivery is in seq order and exactly once: the cursor only advances, and any
      // item at or below it, from either source, has already been sent.
      const deliver = (item: StreamItem): boolean => {
        const endDeliver = traceServer('sse.deliver', serverTraceContext(sessionId, item.turnId), {
          count: 1, ...(typeof item.seq === 'number' ? { seq: item.seq, duplicate: item.seq <= cursor } : {}),
        })
        let failed = false
        try {
          if (typeof item.seq === 'number') {
            if (item.seq <= cursor) return false
            cursor = item.seq
          }
          if (item.type === 'turn_start') running = true
          if (item.type === 'done' || item.type === 'error') running = false
          send(`id: ${item.seq ?? ''}\ndata: ${JSON.stringify(item)}\n\n`)
          if (options.closeWhen?.(item)) {
            close()
            return true
          }
          return false
        } catch (error) {
          failed = true
          throw error
        } finally {
          endDeliver({ failed })
        }
      }
      // A failed journal read ends the stream with an error line, unless the stream
      // already ended while the read was pending: the client left, or a terminal
      // item closed it.
      const fail = (error: unknown) => {
        if (stopped) return
        send(`data: ${JSON.stringify({ type: 'error', text: `event journal unavailable: ${String((error as Error)?.message ?? error)}` })}\n\n`)
        close()
      }
      // Every poll starts here, so no poll's failure goes unhandled.
      const pollSoon = () => {
        void poll().catch(fail)
      }
      const poll = async () => {
        if (stopped) return
        if (polling) {
          pollAgain = true
          return
        }
        polling = true
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = null
        try {
          const [items, draft] = await traceAsync('sse.poll', serverTraceContext(sessionId),
            () => Promise.all([readEvents(sessionId, cursor), readDraft(sessionId, draftCursor).catch(() => null)] as const), { seq: cursor })
          for (const item of items) {
            if (stopped || deliver(item)) return
          }
          if (stopped) return
          if (draft) {
            draftCursor = draft.cursor
            if (!draft.item.draftClosed) running = true
            deliver(draft.item)
          }
          pollDelayMs = items.length > 0 || draft ? 100 : Math.min(running ? 150 : options.maxIdleMs ?? 1000, Math.ceil(pollDelayMs * 1.5))
        } finally {
          polling = false
        }
        if (stopped) return
        if (pollAgain) {
          pollAgain = false
          pollSoon()
          return
        }
        pollTimer = setTimeout(pollSoon, pollDelayMs)
      }

      // Same-process commits arrive here as they land. The next item in sequence is
      // delivered at once; a gap means another instance wrote in between, so read
      // the journal now instead of waiting for the timer.
      onLocal = (item) => {
        if (stopped || typeof item.seq !== 'number' || item.seq <= cursor) return
        if (item.seq === cursor + 1) {
          deliver(item)
          pollDelayMs = 100
        } else {
          pollSoon()
        }
      }
      localEvents.on(sessionId, onLocal)
      // A local write wakes the shared reader; bytes always come from the store,
      // with its generation and offset, just as they do on another instance.
      onLive = (item) => {
        if (!stopped && item.type === 'design_draft') pollSoon()
      }
      localEvents.on(`${sessionId}:live`, onLive)

      pollSoon()
      heartbeat = setInterval(() => send(': ping\n\n'), 15_000)
      if (options.wake) {
        options.wake()
        wakeTimer = setInterval(options.wake, 5_000)
      }
      if (options.maxLifetimeMs) lifetimeTimer = setTimeout(close, options.maxLifetimeMs)
    },
    cancel() {
      stopTimers()
    },
  })
}
