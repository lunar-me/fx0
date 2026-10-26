import { log, warmChat } from '../../../lib/agent'
import { withSessionRoute } from '../../../lib/route-auth'

export const maxDuration = 60

// Called while the user types. The owner check, runtime binding, state hydration and
// the process's libfx agent happen now, so the send that follows skips them. Best
// effort: failures stay quiet.
export const POST = withSessionRoute(async (_request, { host }) => {
  const started = performance.now()
  try {
    await warmChat(host)
    log(host.id, 'warm:ready', { durationMs: Math.round(performance.now() - started) })
  } catch {
    log(host.id, 'warm:skipped', { durationMs: Math.round(performance.now() - started) })
  }
  return new Response(null, { status: 204 })
})
