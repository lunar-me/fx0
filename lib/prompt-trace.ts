import type { StreamItem } from './events'
import type { createTraceRecorder, TraceContext, TraceNumbers } from './performance-trace'

type End = ReturnType<ReturnType<typeof createTraceRecorder>['start']>
type Prompt = {
  traceId: string
  sessionId?: string
  clientId?: string
  messageId?: number
  turnId?: number
  endTurn: End
  endE2e: End
  acknowledged: boolean
  firstContent: boolean
  firstDraft: boolean
  finished: boolean
  revision?: number
  painted: boolean
  result?: TraceNumbers
}

const positive = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! > 0

/** Observe only contiguous, deduplicated delivery, never raw POST/SSE arrivals. */
export function createPromptTrace(recorder: Pick<ReturnType<typeof createTraceRecorder>, 'start' | 'instant'>): {
  begin(traceId: string, sessionId?: string, clientId?: string): void
  observe(sessionId: string, item: StreamItem): void
  acknowledged(traceId: string): void
  fail(traceId: string, cancelled?: boolean): void
  presented(sessionId: string, revision: number): boolean
  clear(): void
} {
  // One bounded owner also bounds all correlation state. No session-wide fallback:
  // queued prompts must not inherit the running turn's content or completion.
  const prompts = new Map<string, Prompt>()
  const context = (prompt: Prompt): TraceContext => ({
    traceId: prompt.traceId,
    ...(prompt.sessionId == null ? {} : { sessionId: prompt.sessionId }),
    ...(prompt.turnId == null ? {} : { turnId: prompt.turnId }),
  })
  const close = (prompt: Prompt, result?: TraceNumbers) => {
    if (!prompt.finished) prompt.endTurn(result)
    prompt.endE2e(result)
    prompts.delete(prompt.traceId)
  }
  const finish = (prompt: Prompt, result: TraceNumbers, immediate: boolean) => {
    if (prompt.finished) return
    prompt.finished = true
    prompt.result = result
    recorder.instant('prompt.finished', context(prompt), result)
    prompt.endTurn(result)
    if (immediate || prompt.revision == null || prompt.painted) close(prompt, result)
  }

  return {
    begin(traceId, sessionId, clientId) {
      // Keep the root join identifier valid even with a recorder supplied by a caller.
      if (!/^[a-f0-9]{32}$/.test(traceId) || prompts.has(traceId)) return
      if (prompts.size === 256) {
        const oldest = prompts.values().next().value!
        close(oldest, { ...oldest.result, incomplete: true })
      }
      const root: TraceContext = { traceId, ...(sessionId == null ? {} : { sessionId }) }
      recorder.instant('prompt.started', root)
      prompts.set(traceId, {
        traceId, sessionId, clientId,
        // Recorder start captures context now. Later session/turn joins use traceId.
        endTurn: recorder.start('prompt.turn', root),
        endE2e: recorder.start('prompt.e2e', root),
        acknowledged: false, firstContent: false, firstDraft: false,
        finished: false, painted: false,
      })
    },
    observe(sessionId, item) {
      // An unjournaled error means reconnect, not turn completion.
      if ((item.type === 'error' || item.type === 'done') && !positive(item.seq)) return

      if (item.type === 'user' || item.type === 'accepted') {
        if (!positive(item.id)) return
        const eligible = [...prompts.values()].filter(prompt => !prompt.finished &&
          (prompt.sessionId == null || prompt.sessionId === sessionId))
        let prompt = item.clientId == null ? undefined : eligible.find(prompt =>
          prompt.clientId === item.clientId && (prompt.messageId == null || prompt.messageId === item.id))
        prompt ??= eligible.find(prompt => prompt.sessionId === sessionId && prompt.messageId === item.id)
        if (!prompt) {
          const unbound = eligible.filter(prompt => prompt.sessionId === sessionId &&
            prompt.clientId == null && prompt.messageId == null)
          // Without a client/message join, ambiguity must not attribute another user's turn.
          if (unbound.length === 1) prompt = unbound[0]
        }
        if (prompt) {
          prompt.sessionId = sessionId
          prompt.messageId = item.id
          prompt.turnId = positive(item.turnId) ? item.turnId : item.id
        }
        return
      }

      if (item.type === 'status' && positive(item.id) && positive(item.turnId)) {
        for (const prompt of prompts.values()) {
          if (!prompt.finished && prompt.sessionId === sessionId && prompt.messageId === item.id) {
            prompt.turnId = item.turnId
          }
        }
        return
      }

      const turnId = item.turnId ?? ((item.type === 'turn_start' || item.type === 'done' || item.type === 'error') ? item.id : undefined)
      if (!positive(turnId)) return
      for (const prompt of prompts.values()) {
        if (prompt.finished || prompt.sessionId !== sessionId || prompt.turnId !== turnId) continue
        if (item.type === 'text' && (item.delta ?? item.text ?? '').trim() && !prompt.firstContent) {
          prompt.firstContent = true
          recorder.instant('prompt.first_content', context(prompt))
        }
        if (item.type === 'design_draft' && item.delta?.length && !prompt.firstDraft) {
          prompt.firstDraft = true
          recorder.instant('prompt.first_draft', context(prompt))
        }
        if (item.type === 'artifact' && positive(item.artifactRevision) &&
            (prompt.revision == null || item.artifactRevision > prompt.revision)) {
          prompt.revision = item.artifactRevision
          prompt.painted = false
        }
        if (item.type === 'done' || item.type === 'error') {
          const cancelled = item.cancelled === true ||
            item.stopReason === 'cancelled' || item.stopReason === 'aborted' || item.stopReason === 'interrupted'
          const failed = item.type === 'error'
          finish(prompt, {
            seq: item.seq,
            ...(prompt.revision == null ? {} : { revision: prompt.revision }),
            ...(cancelled ? { cancelled: true } : {}),
            ...(failed ? { failed: true } : {}),
          }, cancelled || failed)
        }
      }
    },
    acknowledged(traceId) {
      const prompt = prompts.get(traceId)
      if (!prompt || prompt.acknowledged) return
      prompt.acknowledged = true
      recorder.instant('prompt.acknowledged', context(prompt))
    },
    // Explicit submission failure only; connection errors belong in observe().
    fail(traceId, cancelled = false) {
      const prompt = prompts.get(traceId)
      if (!prompt) return
      const result: TraceNumbers = cancelled ? { cancelled: true } : { failed: true }
      if (prompt.finished) close(prompt, { ...prompt.result, ...result })
      else finish(prompt, result, true)
    },
    presented(sessionId, revision) {
      let matched = false
      for (const prompt of prompts.values()) {
        if (prompt.sessionId !== sessionId || prompt.revision !== revision) continue
        matched = true
        if (!prompt.painted) recorder.instant('preview.presented', context(prompt), { revision })
        prompt.painted = true
        if (prompt.finished) close(prompt, prompt.result)
      }
      return matched
    },
    // A manual trace reset discards handles without manufacturing completions.
    clear() { prompts.clear() },
  }
}
