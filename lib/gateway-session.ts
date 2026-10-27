import type { SessionData } from './secure-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { traceServer, traceServerEvent } from './trace-server.ts'
import type { TraceContext } from './performance-trace'
import type { SessionState } from './session'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from './accounts.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { MIN_GATEWAY_VALIDITY_MS } from './auth-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { redactSecrets } from './auth-crypto.ts'
import type { TrialCredential } from './trial'

export function assertGatewaySession(session: SessionData | null, minimumValidity = 30_000): asserts session is SessionData {
  if (!session?.isLoggedIn || !session.userId || !session.accessToken) throw new AuthError()
  if (!session.teamId?.startsWith('team_')) throw new AuthError(403, 'Reauthorize AI Gateway access')
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + minimumValidity) {
    throw new AuthError(503, 'Authentication needs renewal; retry shortly')
  }
}

function canGenerate(credential: Pick<SessionData, 'expiresAt'>): boolean {
  return Number.isFinite(credential.expiresAt) && credential.expiresAt > Date.now() + MIN_GATEWAY_VALIDITY_MS
}

// Authorization is done by the route before binding. Stale parallel requests
// cannot put an older access token back into an already-refreshed runtime.
export function bindGatewaySession(host: SessionState, session: SessionData, { submitter = false } = {}): void {
  const current = host.gatewaySession
  if (current && current.userId !== session.userId) throw new AuthError(404, 'Session not found')
  const sameLogin = current?.loginId === session.loginId
  // The submitter's credential (and team choice) runs the prompt it sends. Otherwise
  // a later token or a team switch from the same login replaces the binding. Another
  // login of this user replaces it when newer, unless that would swap a usable
  // credential for one that can no longer generate, and whenever the bound one can
  // no longer generate but this one can.
  const replace = !current || submitter || (sameLogin
    ? session.expiresAt > current.expiresAt || (session.teamId !== current.teamId && session.expiresAt >= current.expiresAt)
    : canGenerate(session) ? session.loginAt > current.loginAt || !canGenerate(current)
      : !canGenerate(current) && session.loginAt > current.loginAt)
  // Copy only the transport fields. Refresh credentials never enter a runtime,
  // checkpoint, tool host, artifact, log, or model prompt.
  if (replace) host.gatewaySession = transportCredential(session)
}

function transportCredential(session: SessionData): SessionData {
  return {
    userId: session.userId, email: session.email, name: session.name,
    loginId: session.loginId, loginAt: session.loginAt,
    accessToken: session.accessToken, teamId: session.teamId,
    expiresAt: session.expiresAt, isLoggedIn: true,
  }
}

export function assertGenerationCredential(host: SessionState): void {
  assertGatewaySession(host.gatewaySession, MIN_GATEWAY_VALIDITY_MS)
}

const PUBLIC_METADATA = ['/v1/models', '/coding-agent/v1/models']

export interface GatewayError { status: number; type: string | null; code: string | null; message: string | null }

// Gateway's own explanation (type and message) is worth showing: it says whether
// a 429 is a free-tier limit, missing credits, or provider capacity. Bodies are
// untrusted and could echo request data, so only those two fields survive, the
// credential and anything token-shaped are scrubbed, and both are length-capped.
async function readGatewayError(response: Response, secret: string): Promise<GatewayError> {
  const fallback = { status: response.status, type: null, code: null, message: null }
  try {
    const text = (await response.text()).slice(0, 8192)
    const body = JSON.parse(text) as { error?: { type?: unknown; code?: unknown; message?: unknown } | string }
    const error = typeof body.error === 'string' ? { message: body.error } : body.error ?? {}
    const scrub = (value: unknown, max: number) => typeof value === 'string' && value.trim()
      ? redactSecrets(value.split(secret).join('[redacted]')).replace(/\s+/g, ' ').trim().slice(0, max)
      : null
    // libfx matches context-overflow and similar recoveries on type, code and message
    // text, so all three survive and the message keeps up to 2 KB.
    return { status: response.status, type: scrub(error.type, 64), code: scrub(error.code, 64), message: scrub(error.message, 2048) }
  } catch {
    return fallback
  }
}

// Decodes the "html" string of a publish_design call from its partial JSON as the
// model writes it, emitting each newly decoded piece. Escapes split across deltas
// wait for the rest; the closing quote ends it.
export function htmlFieldExtractor(emit: (chunk: string) => void): (delta: string) => void {
  let raw = ''
  let pos = -1
  let done = false
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }
  return (delta) => {
    if (done) return
    raw += delta
    if (pos < 0) {
      const start = /"html"\s*:\s*"/.exec(raw)
      if (!start) return
      pos = start.index + start[0].length
    }
    let out = ''
    while (pos < raw.length) {
      const char = raw[pos]
      if (char === '"') {
        done = true
        break
      }
      if (char !== '\\') {
        out += char
        pos++
        continue
      }
      if (pos + 1 >= raw.length) break
      const next = raw[pos + 1]
      if (next === 'u') {
        if (pos + 6 > raw.length) break
        out += String.fromCharCode(parseInt(raw.slice(pos + 2, pos + 6), 16))
        pos += 6
        continue
      }
      out += escapes[next] ?? next
      pos += 2
    }
    if (out) emit(out)
  }
}

// Gateway streams a tool call's arguments as tool-input-delta parts. libfx only
// surfaces the finished call, so the transport observes those partial arguments.
export interface DesignDraftObserver {
  delta(callId: string, chunk: string): void
  end?(callId: string): Promise<void> | void
  abort?(): Promise<void> | void
}

// Observe on the SDK's own read path. The argument-end flush happens before
// libfx receives those bytes, and cancelling the response cancels the observer.
function watchDesignDrafts(body: ReadableStream<Uint8Array>, observer: DesignDraftObserver, context?: TraceContext): ReadableStream<Uint8Array> {
    const endStream = traceServer('model.stream', context)
    let count = 0
    let bytes = 0
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const designs = new Map<string, (delta: string) => void>()
    let buffer = ''
    const parse = async () => {
      let boundary = buffer.indexOf('\n')
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        boundary = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        let part: { type?: string; id?: string; toolName?: string; delta?: string }
        try { part = JSON.parse(line.slice(5)) } catch { continue }
        if (part.type === 'tool-input-start' && part.toolName === 'publish_design' && part.id) {
          const id = part.id
          designs.set(id, htmlFieldExtractor((chunk) => observer.delta(id, chunk)))
        } else if (part.type === 'tool-input-delta' && part.id && typeof part.delta === 'string') {
          designs.get(part.id)?.(part.delta)
        } else if (part.type === 'tool-input-end' && part.id && designs.has(part.id)) {
          await observer.end?.(part.id)
          designs.delete(part.id)
        } else if (part.type === 'error') {
          await observer.abort?.()
          designs.clear()
        }
      }
    }
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
        const { value, done } = await reader.read()
        if (done) {
          buffer += decoder.decode() + '\n'
          await parse()
          if (designs.size) await observer.abort?.()
          reader.releaseLock()
          controller.close()
          endStream({ count, bytes })
          return
        }
        count++
        bytes += value.byteLength
        if (count === 1) traceServerEvent('model.first_chunk', context, { bytes: value.byteLength, first: true })
        buffer += decoder.decode(value, { stream: true })
        await parse()
        controller.enqueue(value)
        } catch (error) {
          endStream({ count, bytes, failed: true })
          await observer.abort?.()
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } finally {
          endStream({ count, bytes, cancelled: true })
          reader.releaseLock()
          await observer.abort?.()
        }
      },
    })
}

function transport(
  session: () => SessionData | TrialCredential | null,
  fetcher: typeof fetch,
  onError?: (error: GatewayError) => void,
  onDraft?: DesignDraftObserver | ((callId: string, chunk: string) => void),
  traceContext?: TraceContext,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== 'https://ai-gateway.vercel.sh' || url.username || url.password) {
      throw new AuthError(403, 'Gateway credentials cannot leave AI Gateway')
    }
    // Model metadata is public and Gateway rejects user OAuth tokens on it with 401.
    // libfx reads capabilities (including fast support) from /coding-agent/v1/models;
    // a 401 there made it drop fast mode ("Fast mode is unavailable…"). Send it bare.
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' && PUBLIC_METADATA.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
      return fetcher(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: init?.signal })
    }
    const credential = session()
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    let secret: string
    if (credential && 'kind' in credential && credential.kind === 'trial') {
      if (process.env.FX0_FREE_PROMPTS !== '1' || !process.env.AI_GATEWAY_API_KEY ||
          !credential.userId || !credential.loginId || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now() + 30_000) {
        throw new AuthError(503, 'Free prompts are temporarily unavailable')
      }
      if (method !== 'POST' || !['/v3/ai/language-model', '/v4/ai/language-model'].includes(url.pathname) ||
          headers.get('ai-language-model-id') !== 'anthropic/claude-opus-5.5-fast') {
        throw new AuthError(400, 'Free prompts use Opus 5.5 Fast')
      }
      secret = process.env.AI_GATEWAY_API_KEY
      headers.delete('x-vercel-ai-gateway-team')
    } else {
      assertGatewaySession(credential as SessionData | null)
      const userCredential = credential as SessionData
      secret = userCredential.accessToken
      headers.set('x-vercel-ai-gateway-team', userCredential.teamId!)
    }
    headers.set('authorization', `Bearer ${secret}`)
    const response = await fetcher(input, { ...init, headers, cache: 'no-store', redirect: 'error' })
    if (response.ok && onDraft && response.body && url.pathname.endsWith('/language-model')) {
      const observer = typeof onDraft === 'function' ? { delta: onDraft } : onDraft
      const body = watchDesignDrafts(response.body, observer, traceContext)
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    if (response.ok) return response
    // Provider error bodies are untrusted and can echo request credentials. Only
    // Gateway's scrubbed type/message pass through; status and backoff survive.
    const gatewayError = await readGatewayError(response, secret)
    onError?.(gatewayError)
    const message = gatewayError.message ?? (response.status === 401 ? 'Sign in again to use AI Gateway' :
      response.status === 403 ? 'Reauthorize AI Gateway access' :
      response.status === 402 ? 'AI Gateway credits are required for this billing team' :
      response.status === 429 ? 'AI Gateway returned 429 Too Many Requests' : 'AI Gateway request failed')
    const safeHeaders = new Headers({ 'content-type': 'application/json' })
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) safeHeaders.set('retry-after', retryAfter)
    const error = {
      message,
      ...(gatewayError.type ? { type: gatewayError.type } : {}),
      ...(gatewayError.code ? { code: gatewayError.code } : {}),
    }
    return new Response(JSON.stringify({ error }), { status: response.status, headers: safeHeaders })
  }
}

// Consecutive 429s before the turn gives up. The runtime otherwise keeps backing
// off on a rate-limited team for minutes while the UI only shows "thinking".
export const RATE_LIMIT_ATTEMPTS = 3

// The closure reads the credential on each call. It performs no identity,
// database, credits, or refresh request. API request auth owns rotation.
export function gatewayFetch(
  host: { gatewaySession: SessionData | TrialCredential | null; rateLimitStreak?: number; lastGatewayError?: GatewayError | null },
  fetcher: typeof fetch = fetch,
  onDesignDraft?: DesignDraftObserver | ((callId: string, chunk: string) => void),
  traceContext?: TraceContext,
): typeof fetch {
  const send = transport(() => host.gatewaySession, fetcher, (error) => { host.lastGatewayError = error }, onDesignDraft, traceContext)
  return async (input, init) => {
    const response = await send(input, init)
    if (response.status !== 429) {
      host.rateLimitStreak = 0
      return response
    }
    host.rateLimitStreak = (host.rateLimitStreak ?? 0) + 1
    if (host.rateLimitStreak < RATE_LIMIT_ATTEMPTS) return response
    // A non-retryable status ends the turn with Gateway's own reason.
    await response.body?.cancel().catch(() => {})
    return new Response(JSON.stringify({ error: { message: host.lastGatewayError?.message ?? 'AI Gateway returned 429 Too Many Requests' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
  }
}
