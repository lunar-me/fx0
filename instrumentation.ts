// Next.js calls register() once when a server instance starts. Measurement only: it
// records when that happened (a no-op unless tracing is enabled, never in production),
// so a cold first prompt shows whether the instance started before the request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { markProcess } = await import('./lib/trace-server')
  markProcess('registered')
}
