// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, emitLive } from './journal.ts'
import { Redis } from '@upstash/redis'
// @ts-expect-error Node strip-types tests require the source extension.
import { createDraftBatch } from './design-draft.ts'
import type { DesignDraftObserver } from './gateway-session'
import type { StreamItem } from './events'
// @ts-expect-error Node strip-types tests require the source extension.
import { serverTraceContext, traceAsync } from './trace-server.ts'

const TTL_MS = 30 * 60_000
const MAX_BYTES = 512 * 1024
let client: Redis | undefined
// Provisional previews have a bounded deadline and do not retry store outages.
function redis(): Redis {
  return client ??= new Redis({ url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN!,
    retry: false, signal: () => AbortSignal.timeout(1500) })
}
const keys = (id: string) => ['state', 'deleting', 'draft', 'draft-chunks'].map(part => prefixed(`session:${id}:${part}`))

const RESERVE = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
if tonumber(redis.call('HGET', KEYS[1], 'draftClosedTurn') or '0') >= tonumber(ARGV[2]) then return false end
redis.call('HSET', KEYS[1], 'draftRequest', ARGV[1])
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('HSET', KEYS[3], 'closed', 1) end
redis.call('DEL', KEYS[4])
return redis.call('HGET', KEYS[1], 'artifactRevision') or '0'
`

// Begin is fenced by the turn's terminal and the artifact version observed before
// the model request. An old response cannot start a draft after it was published.
const BEGIN = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('HGET', KEYS[1], 'draftRequest') ~= ARGV[6] then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'draftClosedTurn') or '0') >= tonumber(ARGV[2]) then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'artifactRevision') or '0') ~= tonumber(ARGV[3]) then return 0 end
local revision = redis.call('HINCRBY', KEYS[1], 'draftRevision', 1)
redis.call('DEL', KEYS[3], KEYS[4])
redis.call('HSET', KEYS[3], 'id', ARGV[1], 'turnId', ARGV[2], 'base', ARGV[3], 'revision', revision, 'callId', ARGV[4], 'request', ARGV[6], 'closed', 0, 'published', 0, 'bytes', 0)
redis.call('PEXPIRE', KEYS[3], ARGV[5])
return revision
`
const APPEND = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('HGET', KEYS[1], 'draftRequest') ~= redis.call('HGET', KEYS[3], 'request') then return 0 end
if redis.call('HGET', KEYS[3], 'id') ~= ARGV[1] or redis.call('HGET', KEYS[3], 'closed') ~= '0' then return 0 end
local bytes = tonumber(redis.call('HGET', KEYS[3], 'bytes') or '0') + tonumber(ARGV[3])
if bytes > tonumber(ARGV[4]) then return 0 end
redis.call('RPUSH', KEYS[4], ARGV[2])
redis.call('HSET', KEYS[3], 'bytes', bytes)
redis.call('PEXPIRE', KEYS[3], ARGV[5])
redis.call('PEXPIRE', KEYS[4], ARGV[5])
return 1
`
const CLOSE = `
if redis.call('HGET', KEYS[3], 'id') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[3], 'closed', 1)
redis.call('DEL', KEYS[4])
return 1
`
const CLOSE_CALL = `
if redis.call('HGET', KEYS[3], 'callId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[3], 'closed', 1)
redis.call('DEL', KEYS[4])
return 1
`
const READ = `
local id = redis.call('HGET', KEYS[3], 'id')
if not id then return false end
local closed = redis.call('HGET', KEYS[3], 'closed') == '1'
local count = redis.call('LLEN', KEYS[4])
local start = id == ARGV[1] and tonumber(ARGV[2]) or 0
if id == ARGV[1] and start == count and not closed then return cjson.encode({unchanged=true}) end
local chunks = redis.call('LRANGE', KEYS[4], start, -1)
return cjson.encode({id=id, closed=closed, published=redis.call('HGET', KEYS[3], 'published') == '1', count=count, revision=tonumber(redis.call('HGET', KEYS[3], 'revision')), turnId=tonumber(redis.call('HGET', KEYS[3], 'turnId')), base=tonumber(redis.call('HGET', KEYS[3], 'base')), chunks=chunks})
`

export interface DraftCursor { id: string; count: number; closed: boolean; revision: number; turnId: number; base: number }

export async function reserveDraft(chatId: string, requestId: string, turnId: number): Promise<number | null> {
  const base = await traceAsync('draft.write', serverTraceContext(chatId, turnId),
    () => redis().eval(RESERVE, keys(chatId), [requestId, turnId]))
  return base === false || base === null ? null : Number(base)
}

export async function beginDraft(chatId: string, id: string, callId: string, turnId: number, base: number, requestId: string): Promise<number> {
  return Number(await traceAsync('draft.write', serverTraceContext(chatId, turnId),
    () => redis().eval(BEGIN, keys(chatId), [id, turnId, base, callId, TTL_MS, requestId]), { revision: base }))
}

export async function appendDraft(chatId: string, id: string, offset: number, delta: string): Promise<boolean> {
  const bytes = Buffer.byteLength(delta)
  return Number(await traceAsync('draft.write', serverTraceContext(chatId),
    () => redis().eval(APPEND, keys(chatId), [id, JSON.stringify({ offset, delta }), bytes, MAX_BYTES, TTL_MS]), { bytes, chars: delta.length })) === 1
}

export async function closeDraft(chatId: string, id: string): Promise<void> {
  await traceAsync('draft.write', serverTraceContext(chatId), () => redis().eval(CLOSE, keys(chatId), [id]))
}

export async function closeDraftCall(chatId: string, callId: string): Promise<void> {
  await traceAsync('draft.write', serverTraceContext(chatId), () => redis().eval(CLOSE_CALL, keys(chatId), [callId]))
}

export async function readDraft(chatId: string, cursor?: DraftCursor): Promise<{ item: StreamItem; cursor: DraftCursor } | null> {
  const raw = await redis().eval<unknown[], unknown>(READ, keys(chatId), [cursor?.id ?? '', cursor?.count ?? 0])
  if (!raw) return cursor && !cursor.closed ? {
    cursor: { ...cursor, closed: true },
    item: { type: 'design_draft', draftId: cursor.id, draftRevision: cursor.revision,
      turnId: cursor.turnId, artifactRevision: cursor.base, draftClosed: true },
  } : null
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw as { id: string; closed: boolean; published: boolean; count: number; revision: number; turnId: number; base: number; chunks: string[]; unchanged?: boolean }
  if (value.unchanged) return null
  if (cursor && cursor.id === value.id && cursor.closed && value.closed) return null
  const chunks: { offset: number; delta: string }[] = Array.isArray(value.chunks) ? value.chunks.map((c: string) => JSON.parse(c)) : []
  return {
    cursor: { id: value.id, count: value.count, closed: value.closed, revision: value.revision, turnId: value.turnId, base: value.base },
    item: { type: 'design_draft', draftId: value.id, draftRevision: value.revision, turnId: value.turnId,
      artifactRevision: value.base, draftClosed: value.closed, draftPublished: value.published, draftOffset: chunks[0]?.offset ?? 0,
      delta: chunks.map(c => c.delta).join('') },
  }
}

export async function storedDraftObserver(chatId: string, turnId: number): Promise<DesignDraftObserver | undefined> {
  const attempt = crypto.randomUUID()
  const base = await reserveDraft(chatId, attempt, turnId)
  if (base == null) return undefined
  const calls = new Map<string, { id: string; offset: number; revision: number }>()
  let stopped = false
  const batch = createDraftBatch(async (callId, delta) => {
    if (stopped) return
    let call = calls.get(callId)
    if (!call) {
      const id = `${attempt}:${callId}`
      calls.set(callId, call = { id, offset: 0, revision: 0 })
      try { call.revision = await beginDraft(chatId, id, callId, turnId, base, attempt) } catch { return }
    }
    if (!call.revision || stopped) return
    try {
      if (await appendDraft(chatId, call.id, call.offset, delta)) {
        call.offset += delta.length
        emitLive(chatId, { type: 'design_draft' })
        return
      }
    } catch { /* An unacknowledged write is ambiguous; never continue past it. */ }
    call.revision = 0
    await closeDraft(chatId, call.id).catch(() => {})
  })
  return {
    delta: batch.delta,
    end: batch.end,
    async abort() {
      stopped = true
      await batch.stop()
      await Promise.all([...calls.values()].map(call => closeDraft(chatId, call.id).catch(() => {})))
    },
  }
}
