import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptTrace } from '../lib/prompt-trace.ts'

const session = '00000000-0000-4000-8000-000000000001'
const otherSession = '00000000-0000-4000-8000-000000000002'
const traceId = 'a'.repeat(32)
const otherTrace = 'b'.repeat(32)

// Deliberately no name allowlist or idempotent end: this tests the adapter before
// the common recorder/browser integration and exposes accidental double closes.
function setup() {
  let time = 0
  const events = []
  const starts = []
  const recorder = {
    start(name, context, attrs) {
      const ts = time
      const args = { ...context, ...attrs }
      starts.push({ name, ts, args: { ...args } })
      return result => events.push({ name, ph: 'X', ts, dur: time - ts, args: { ...args, ...result } })
    },
    instant(name, context, attrs) {
      events.push({ name, ph: 'i', ts: time, args: { ...context, ...attrs } })
    },
  }
  const prompt = createPromptTrace(recorder)
  return {
    prompt, events, starts,
    at(value) { time = value },
    named(name) { return events.filter(event => event.name === name) },
    bind(id = 1, clientId = 'client', target = session) {
      prompt.observe(target, { type: 'user', id, clientId, seq: id })
    },
    done(id = 1, extra = {}, target = session) {
      prompt.observe(target, { type: 'done', id, turnId: id, seq: 100, ...extra })
    },
    artifact(revision, turnId = 1, target = session) {
      prompt.observe(target, { type: 'artifact', artifactRevision: revision, turnId, seq: 50 + revision })
    },
  }
}

const span = (fixture, name = 'prompt.e2e') => fixture.named(name)

test('send click starts root spans immediately; journal done closes a text-only turn', () => {
  const f = setup()
  f.at(2)
  f.prompt.begin(traceId, session, 'client')
  assert.deepEqual(f.events, [{ name: 'prompt.started', ph: 'i', ts: 2, args: { traceId, sessionId: session } }])
  assert.deepEqual(f.starts.map(start => start.name), ['prompt.turn', 'prompt.e2e'])
  f.at(4)
  f.prompt.acknowledged(traceId)
  f.prompt.acknowledged(traceId)
  f.bind()
  f.at(20)
  f.done()
  assert.equal(f.named('prompt.acknowledged').length, 1)
  assert.equal(span(f, 'prompt.turn')[0].dur, 18)
  assert.equal(span(f)[0].dur, 18)
  assert.deepEqual(f.named('prompt.finished')[0].args, { traceId, sessionId: session, turnId: 1, seq: 100 })
  f.done()
  f.prompt.fail(traceId)
  f.prompt.presented(session, 1)
  assert.equal(span(f).length, 1)
  assert.equal(span(f, 'prompt.turn').length, 1)
})

test('new session joins by saved clientId, not the first unrelated user', () => {
  const f = setup()
  f.prompt.begin(traceId, undefined, 'client')
  f.bind(1, 'remote', otherSession)
  f.done(1, {}, otherSession)
  assert.equal(span(f).length, 0)
  f.bind(8, 'client')
  f.prompt.observe(session, { type: 'text', turnId: 8, delta: 'visible content' })
  f.done(8)
  assert.deepEqual(f.starts[0].args, { traceId })
  assert.deepEqual(span(f)[0].args, { traceId, seq: 100 })
  assert.deepEqual(f.named('prompt.first_content')[0].args, { traceId, sessionId: session, turnId: 8 })
})

test('accepted binds message id so a user without clientId can join the same prompt', () => {
  const f = setup()
  f.prompt.begin(traceId, undefined, 'client')
  f.prompt.observe(session, { type: 'accepted', id: 8, clientId: 'client' })
  f.prompt.observe(session, { type: 'user', id: 8, seq: 1 })
  f.done(8)
  assert.equal(span(f).length, 1)
})

test('a known session without clientId binds only an unambiguous user', () => {
  const f = setup()
  f.prompt.begin(traceId, session)
  f.prompt.observe(otherSession, { type: 'user', id: 1, seq: 1 })
  f.done(1, {}, otherSession)
  assert.equal(span(f).length, 0)
  f.prompt.observe(session, { type: 'user', id: 4, seq: 2 })
  f.done(4)
  assert.equal(span(f).length, 1)

  const ambiguous = setup()
  ambiguous.prompt.begin(traceId, session)
  ambiguous.prompt.begin(otherTrace, session)
  ambiguous.bind()
  ambiguous.done()
  assert.equal(span(ambiguous).length, 0)
})

test('only visible text triggers first_content, and only received draft bytes trigger first_draft', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  for (const item of [
    { type: 'reasoning', delta: 'private reasoning' },
    { type: 'tool_start', command: 'private command' },
    { type: 'status', text: 'status text' },
    { type: 'text', delta: '' },
    { type: 'text', delta: ' \n ' },
    { type: 'design_draft', delta: '', draftClosed: true },
  ]) f.prompt.observe(session, { ...item, turnId: 1 })
  f.prompt.presented(session, 1)
  assert.equal(f.named('prompt.first_content').length, 0)
  assert.equal(f.named('prompt.first_draft').length, 0)
  f.at(3)
  f.prompt.observe(session, { type: 'design_draft', turnId: 1, delta: '<html>private draft</html>' })
  f.at(5)
  f.prompt.observe(session, { type: 'text', turnId: 1, delta: 'private response' })
  f.prompt.observe(session, { type: 'text', turnId: 1, text: 'more private response' })
  f.prompt.observe(session, { type: 'design_draft', turnId: 1, delta: 'more private draft' })
  assert.equal(f.named('prompt.first_draft')[0].ts, 3)
  assert.equal(f.named('prompt.first_content')[0].ts, 5)
  assert.equal(f.named('prompt.first_draft').length, 1)
  assert.equal(f.named('prompt.first_content').length, 1)
  assert.doesNotMatch(JSON.stringify(f.events), /private|html|command|response/)
})

test('E2E waits for done AND final artifact presentation, not draft paint or other revisions', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(1)
  f.prompt.presented(session, 1)
  assert.equal(span(f).length, 0)
  f.artifact(2)
  f.at(10)
  f.done()
  assert.equal(span(f, 'prompt.turn')[0].dur, 10)
  assert.equal(f.named('prompt.finished')[0].ts, 10)
  assert.equal(span(f).length, 0)
  f.prompt.presented(otherSession, 2)
  f.prompt.presented(session, 1)
  f.prompt.presented(session, 3)
  assert.equal(span(f).length, 0)
  f.at(18)
  f.prompt.presented(session, 2)
  f.prompt.presented(session, 2)
  assert.equal(span(f)[0].dur, 18)
  assert.equal(span(f)[0].args.revision, 2)
  assert.equal(span(f).length, 1)
})

test('final artifact can paint before done, but a presentation before its artifact is ignored', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.prompt.presented(session, 2)
  f.artifact(2)
  f.at(6)
  f.prompt.presented(session, 2)
  f.at(10)
  f.done()
  assert.equal(span(f)[0].dur, 10)

  const early = setup()
  early.prompt.begin(traceId, session, 'client')
  early.bind()
  early.prompt.presented(session, 2)
  early.artifact(2)
  early.done()
  assert.equal(span(early).length, 0)
})

test('unrelated session/turn artifacts and drafts never affect a prompt', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2, 2)
  f.artifact(2, 1, otherSession)
  f.prompt.observe(session, { type: 'design_draft', turnId: 2, delta: 'draft' })
  f.prompt.observe(otherSession, { type: 'text', turnId: 1, delta: 'text' })
  f.done(2)
  assert.equal(span(f).length, 0)
  f.done()
  assert.equal(span(f).length, 1)
  assert.equal(f.named('prompt.first_content').length, 0)
  assert.equal(f.named('prompt.first_draft').length, 0)
})

test('steering status reassigns a queued message to the running turn, sharing its terminal and preview', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'first')
  f.bind(1, 'first')
  f.prompt.begin(otherTrace, session, 'steer')
  f.bind(2, 'steer')
  f.prompt.observe(session, { type: 'text', turnId: 1, delta: 'before steering' })
  assert.equal(f.named('prompt.first_content').length, 1)
  f.prompt.observe(session, { type: 'status', id: 2, turnId: 1, seq: 3 })
  f.prompt.observe(session, { type: 'text', turnId: 1, delta: 'after steering' })
  assert.equal(f.named('prompt.first_content').length, 2)
  assert.equal(f.named('prompt.first_content')[1].args.traceId, otherTrace)
  assert.equal(f.named('prompt.first_content')[1].args.turnId, 1)
  f.artifact(3)
  f.done(2)
  assert.equal(span(f, 'prompt.turn').length, 0)
  f.done(1)
  assert.equal(span(f, 'prompt.turn').length, 2)
  assert.equal(span(f).length, 0)
  f.prompt.presented(session, 3)
  assert.equal(span(f).length, 2)
})

test('queued prompts do not close with the preceding turn', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'first')
  f.bind(1, 'first')
  f.prompt.begin(otherTrace, session, 'queued')
  f.bind(2, 'queued')
  f.done(1)
  assert.deepEqual(span(f).map(event => event.args.traceId), [traceId])
  f.done(2)
  assert.deepEqual(span(f).map(event => event.args.traceId), [traceId, otherTrace])
})

test('connection errors and unjournaled done do not finish; journaled errors do', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2)
  for (const seq of [undefined, NaN, Infinity, 0, -1, 1.5]) {
    f.prompt.observe(session, { type: 'error', turnId: 1, seq, text: 'connection interrupted' })
    f.prompt.observe(session, { type: 'done', turnId: 1, seq })
  }
  assert.equal(span(f).length, 0)
  assert.equal(f.named('prompt.finished').length, 0)
  f.prompt.observe(session, { type: 'error', id: 1, seq: 20, text: 'private failure' })
  assert.equal(span(f)[0].args.failed, true)
  assert.equal(span(f, 'prompt.turn')[0].args.failed, true)
  assert.equal(f.named('prompt.finished').length, 1)
  assert.doesNotMatch(JSON.stringify(f.events), /private|connection/)
})

for (const stopReason of ['cancelled', 'aborted', 'interrupted']) {
  test(`${stopReason} closes cancelled immediately without waiting for preview`, () => {
    const f = setup()
    f.prompt.begin(traceId, session, 'client')
    f.bind()
    f.artifact(2)
    f.done(1, { stopReason })
    assert.equal(span(f)[0].args.cancelled, true)
    assert.equal(span(f, 'prompt.turn')[0].args.cancelled, true)
    assert.equal(f.named('prompt.finished')[0].args.cancelled, true)
    f.prompt.presented(session, 2)
    assert.equal(span(f).length, 1)
  })
}

test('explicit cancelled flag and submission failures close once without exposing errors', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2)
  f.done(1, { cancelled: true })
  assert.equal(span(f)[0].args.cancelled, true)
  for (const cancelled of [false, true]) {
    const failure = setup()
    failure.prompt.begin(traceId)
    failure.prompt.fail(traceId, cancelled)
    failure.prompt.fail(traceId, cancelled)
    assert.deepEqual(span(failure)[0].args, { traceId, [cancelled ? 'cancelled' : 'failed']: true })
    assert.equal(span(failure).length, 1)
    assert.equal(failure.named('prompt.finished').length, 1)
  }
})

test('bounded ownership evicts the oldest of 256 with incomplete, not a fake finished milestone', () => {
  const f = setup()
  for (let i = 0; i < 257; i++) f.prompt.begin(i.toString(16).padStart(32, '0'), session, `client-${i}`)
  assert.equal(span(f).length, 1)
  assert.equal(span(f, 'prompt.turn').length, 1)
  assert.deepEqual(span(f)[0].args, { traceId: '0'.repeat(32), sessionId: session, incomplete: true })
  assert.equal(f.named('prompt.finished').length, 0)
  f.prompt.fail('0'.repeat(32))
  assert.equal(span(f).length, 1)
  f.bind(2, 'client-256')
  f.done(2)
  assert.equal(span(f).length, 2)
})

test('eviction of a preview-waiting prompt does not close its turn twice', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2)
  f.done()
  for (let i = 0; i < 256; i++) f.prompt.begin(i.toString(16).padStart(32, '0'))
  assert.equal(span(f, 'prompt.turn').length, 1)
  assert.equal(span(f).length, 1)
  assert.equal(span(f)[0].args.incomplete, true)
  f.prompt.presented(session, 2)
  assert.equal(span(f).length, 1)
})

test('clear discards trackers silently and lets the same root trace start again', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2)
  f.done()
  f.prompt.begin(otherTrace, session, 'second')
  const before = structuredClone(f.events)
  f.prompt.clear()
  f.prompt.presented(session, 2)
  f.prompt.acknowledged(otherTrace)
  f.prompt.fail(otherTrace)
  f.done()
  assert.deepEqual(f.events, before)
  f.prompt.begin(traceId, session, 'client')
  f.bind(3)
  f.done(3)
  assert.equal(span(f).length, 1)
})

test('invalid trace ids are ignored; repeated begin cannot replace a live root', () => {
  const f = setup()
  for (const id of ['', 'private prompt', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33)]) f.prompt.begin(id)
  assert.equal(f.events.length, 0)
  assert.equal(f.starts.length, 0)
  f.prompt.begin(traceId, session, 'client')
  f.at(5)
  f.prompt.begin(traceId, otherSession, 'replacement')
  f.bind()
  f.at(10)
  f.done()
  assert.equal(f.named('prompt.started').length, 1)
  assert.equal(span(f)[0].dur, 10)
})

test('repeated terminal and stale artifact events cannot change a preview-waiting completion', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(3)
  f.artifact(2)
  f.done()
  f.done()
  f.prompt.observe(session, { type: 'error', id: 1, seq: 101 })
  f.prompt.observe(session, { type: 'text', turnId: 1, delta: 'late content' })
  f.artifact(4)
  f.prompt.presented(session, 2)
  assert.equal(span(f).length, 0)
  f.prompt.presented(session, 3)
  assert.equal(span(f).length, 1)
  assert.equal(span(f)[0].args.revision, 3)
  assert.equal(span(f)[0].args.failed, undefined)
  assert.equal(span(f, 'prompt.turn').length, 1)
  assert.equal(f.named('prompt.finished').length, 1)
  assert.equal(f.named('prompt.first_content').length, 0)
})

test('a turn_start alone cannot steal an unbound prompt from another client', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.prompt.observe(session, { type: 'turn_start', id: 1, seq: 2 })
  f.done()
  assert.equal(span(f).length, 0)
  f.bind(2)
  f.prompt.observe(session, { type: 'turn_start', id: 2, seq: 4 })
  f.prompt.observe(session, { type: 'text', turnId: 2, text: 'visible text' })
  f.done(2)
  assert.equal(span(f).length, 1)
  assert.equal(f.named('prompt.first_content').length, 1)
})

test('completed prompts free capacity instead of evicting other live prompts', () => {
  const f = setup()
  for (let i = 0; i < 300; i++) {
    const id = i.toString(16).padStart(32, '0')
    f.prompt.begin(id, session, `client-${i}`)
    f.bind(i + 1, `client-${i}`)
    f.done(i + 1)
  }
  assert.equal(span(f).length, 300)
  assert.ok(span(f).every(event => event.args.incomplete == null))
})

test('explicit failure while awaiting preview closes only E2E, leaving the journal terminal intact', () => {
  const f = setup()
  f.prompt.begin(traceId, session, 'client')
  f.bind()
  f.artifact(2)
  f.done()
  f.prompt.fail(traceId)
  f.prompt.presented(session, 2)
  assert.equal(span(f).length, 1)
  assert.equal(span(f)[0].args.failed, true)
  assert.equal(span(f)[0].args.revision, 2)
  assert.equal(span(f, 'prompt.turn').length, 1)
  assert.equal(f.named('prompt.finished').length, 1)
})

test('unknown handles and empty journals have no tracing side effects', () => {
  const f = setup()
  f.prompt.acknowledged(traceId)
  f.prompt.fail(traceId)
  f.prompt.observe(session, { type: 'done', id: 1, seq: 1 })
  f.prompt.presented(session, 1)
  f.prompt.clear()
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.starts, [])
})
