import { log, warmChat, warmProcess } from '../../../lib/agent'
import { withChatRoute, withSessionRoute } from '../../../lib/route-auth'

// The same maxDuration as /api/prompt, so Vercel bundles both routes into one function
// and this warm-up runs on the instances that serve the prompt. With a different value
// they become separate functions, and warming one leaves the other cold.
export const maxDuration = 800

// Called while the user types in a chat. The owner check, runtime binding, state
// hydration and the process's libfx agent happen now, so the send that follows skips
// them. Best effort: failures stay quiet.
const warmSession = withSessionRoute(async (_request, { host }) => {
  try {
    await warmChat(host)
  } catch {
    log(host.id, 'warm:skipped', {})
  }
  return new Response(null, { status: 204 })
})

// Called when the app opens, a new chat starts or the tab returns, before any chat
// exists. Signed-in callers only; it reads and writes no chat, only this instance's
// libfx agent and durable backend.
const warmInstance = withChatRoute(async () => {
  try {
    await warmProcess()
  } catch {
    log('instance', 'warm:skipped', {})
  }
  return new Response(null, { status: 204 })
})

export const POST = (request: Request) =>
  new URL(request.url).searchParams.has('session') ? warmSession(request) : warmInstance(request)
