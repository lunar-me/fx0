import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFxAgent } from 'libfx'
import { local } from 'libfx/durable-local'

// EXPERIMENT ONLY: proves the patched libfx admission (scripts/patch-libfx-experiment.mjs)
// keeps its invariants on the real installed SDK, with a local World instrumented
// at the same calls Vercel's World serves over the network:
// - the viewer's start (streams.getInfo) lands before the message is written (events.create);
// - send()'s own log read now overlaps that start, which is the latency the change removes;
// - a failed start writes nothing and rejects acceptance; a retry then runs exactly once.

const sse = text => new Response([
  `data: ${JSON.stringify({ type: 'text-delta', id: 'answer', delta: text })}`,
  'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}',
  'data: [DONE]', '',
].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })

function observed(dir, { failViewerStart = 0, viewerStartDelayMs = 40 } = {}) {
  const base = local({ dir })
  const timeline = []
  let failures = failViewerStart
  const world = () => {
    const w = base.world()
    const track = (name, call) => async (...args) => {
      timeline.push(`start ${name}`)
      try {
        const value = await call(...args)
        timeline.push(`end ${name}`)
        return value
      } catch (error) {
        timeline.push(`fail ${name}`)
        throw error
      }
    }
    return {
      ...w,
      events: { ...w.events, create: track('write', (...a) => w.events.create(...a)), list: track('read', (...a) => w.events.list(...a)) },
      streams: {
        ...w.streams,
        getInfo: track('viewerStart', async (...a) => {
          await new Promise(resolve => setTimeout(resolve, viewerStartDelayMs))
          if (failures > 0) { failures--; throw new Error('synthetic viewer-start failure') }
          return w.streams.getInfo(...a)
        }),
      },
    }
  }
  return { durability: { ...base, world }, timeline }
}

function agentWith(durability, requests) {
  return createFxAgent({
    durability, apiKey: 'synthetic-experiment-key', model: 'sdk/experiment-model', instructions: 'Reply briefly.', tools: [],
    fetch: async (_url, init = {}) => {
      if ((init.method ?? 'GET') === 'GET') return Response.json({ data: [{ id: 'sdk/experiment-model', type: 'language' }] })
      requests.push(1)
      return sse('OK')
    },
  })
}

async function drain(turn) {
  const result = turn.result
  void result.catch(() => {})
  let text = ''
  try { for await (const event of turn) if (event.type === 'text_delta') text += event.delta } catch {}
  return { result: await result.catch(error => error), text }
}

test('patched admission reads the viewer start before any write and overlaps send()\'s read', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-viewer-start-'))
  const { durability, timeline } = observed(dir)
  const requests = []
  const agent = agentWith(durability, requests)
  try {
    const turn = agent.session().prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await turn.accepted
    const { result, text } = await drain(turn)
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(text, 'OK', 'the viewer sees the whole turn from its start')
    assert.equal(requests.length, 1)
    const viewerEnd = timeline.indexOf('end viewerStart')
    const firstWrite = timeline.indexOf('start write')
    assert.ok(viewerEnd >= 0 && firstWrite > viewerEnd, `no write before the viewer start lands: ${timeline.join(', ')}`)
    const firstRead = timeline.indexOf('start read')
    assert.ok(firstRead >= 0 && firstRead < viewerEnd, `send()'s read overlaps the viewer start: ${timeline.join(', ')}`)
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// libfx's ui.length() treats a failed stream lookup as an empty stream (0) and never
// rejects, with or without the patch. The turn must still run once from that start, and a
// retry of the same messageId must answer from the log without running the model again.
test('a failed viewer-start lookup still runs the turn once; a retry answers from the log', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-viewer-start-fail-'))
  const { durability, timeline } = observed(dir, { failViewerStart: 1 })
  const requests = []
  const agent = agentWith(durability, requests)
  try {
    const session = agent.session()
    const first = session.prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await first.accepted
    const { result, text } = await drain(first)
    assert.ok(timeline.includes('fail viewerStart'), 'the synthetic lookup failure happened')
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(text, 'OK', 'an empty-stream start still shows the whole turn')
    assert.equal(requests.length, 1)

    const again = session.prompt('Hello', { messageId: 'm1', signal: AbortSignal.timeout(10_000) })
    await again.accepted
    assert.equal((await drain(again)).result.stopReason, 'end_turn')
    assert.equal(requests.length, 1, 'a retry of a finished message answers from the log')
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})
