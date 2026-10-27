import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// A persistent profile is a dedicated, marked directory created by createPerfProfile.
// Chrome's own user-data directories are never accepted, even with a marker.
const profileMarker = '.fx0-perf-profile.json'
const profileMarkerBody = { version: 1, purpose: 'fx0-performance' }
const chromeUserDataDirs = [
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Google/Chrome Beta',
  'Library/Application Support/Google/Chrome Canary', 'Library/Application Support/Chromium',
  '.config/google-chrome', '.config/chromium', 'AppData/Local/Google/Chrome/User Data',
].map(relative => path.join(homedir(), relative).toLowerCase())

function refuseChromeUserData(candidate) {
  const lower = candidate.toLowerCase()
  if (chromeUserDataDirs.some(root => lower === root || lower.startsWith(root + path.sep))) {
    throw new Error('Refusing a Chrome user data directory; use a dedicated fx0 performance profile')
  }
}

async function entryInfo(file) {
  try { return await lstat(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function hasPerfMarker(realDirectory) {
  const info = await entryInfo(path.join(realDirectory, profileMarker))
  if (!info?.isFile() || info.size > 512) return false
  let marker
  try { marker = JSON.parse(await readFile(path.join(realDirectory, profileMarker), 'utf8')) }
  catch { return false }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false
  return Object.keys(marker).sort().join(',') === 'purpose,version' &&
    marker.version === profileMarkerBody.version && marker.purpose === profileMarkerBody.purpose
}

// Parent of a new profile must already exist; the directory itself is never recursive.
export async function createPerfProfile(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Profile directory is required')
  const target = path.resolve(directory)
  refuseChromeUserData(target)
  const existing = await entryInfo(target)
  let real
  if (existing) {
    if (!existing.isDirectory()) throw new Error('Profile path exists and is not a real directory')
    real = await realpath(target)
    refuseChromeUserData(real)
    if (await hasPerfMarker(real)) return real
    if ((await readdir(real)).length) throw new Error('Existing profile directory is not empty and has no valid fx0 performance marker')
  } else {
    real = path.join(await realpath(path.dirname(target)), path.basename(target))
    refuseChromeUserData(real)
    await mkdir(target, { mode: 0o700 })
  }
  await writeFile(path.join(real, profileMarker), JSON.stringify(profileMarkerBody) + '\n', { mode: 0o600, flag: 'wx' })
  return real
}

export function loopbackUrl(input) {
  if (typeof input !== 'string' || !/^https?:\/\//iu.test(input) || /[\s\\\x00-\x1f\x7f]/u.test(input) || /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/iu.test(input)) throw new Error('URL must be an explicit loopback HTTP(S) URL without username/password')
  let url
  try { url = new URL(input) } catch { throw new Error('Invalid URL') }
  const host = url.hostname
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port === '0' ||
      !(host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host))) {
    throw new Error('Only loopback HTTP(S) URLs without username/password are allowed')
  }
  return url
}

// Where a live performance run may send a prompt: this machine, or an fx0 Vercel
// preview over HTTPS. Production (fx0.vercel.dev or any custom domain) is never accepted.
const PREVIEW_HOST = /^fx0-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:labs\.vercel\.dev|vercel\.app)$/
export function labTargetUrl(input) {
  try { return { url: loopbackUrl(input), kind: 'local' } } catch {}
  if (typeof input !== 'string' || /[\s\\\x00-\x1f\x7f]/u.test(input)) throw new Error('URL must be loopback or an fx0 preview over HTTPS')
  let url
  try { url = new URL(input) } catch { throw new Error('Invalid URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PREVIEW_HOST.test(url.hostname)) {
    throw new Error('URL must be loopback or an fx0 preview over HTTPS (fx0-*.labs.vercel.dev or fx0-*.vercel.app); production is never measured')
  }
  return { url, kind: 'preview' }
}

// The inspector is always the owned Chrome's numeric IPv4 loopback endpoint.
export function inspectorJson(port, route, { timeoutMs = 5000, signal } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['/json/version', '/json/list'].includes(route)) {
    throw new Error('Invalid inspector endpoint')
  }
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path: route, signal }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('Inspector returned a non-200 response'))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) response.destroy(new Error('Inspector response exceeds limit'))
        else chunks.push(chunk)
      })
      response.on('error', () => reject(new Error('Inspector response failed')))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('Invalid inspector JSON')) }
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('Inspector timed out')), timeoutMs)
    request.once('close', () => clearTimeout(timer))
    request.once('error', () => reject(new Error('Inspector connection failed or timed out')))
  })
}

function inspectorSocket(input, port) {
  let url
  try { url = new URL(input) } catch { throw new Error('Invalid inspector WebSocket') }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port ||
      url.username || url.password || url.search || url.hash || !/^\/devtools\/(?:page|browser)\/[\w-]+$/.test(url.pathname)) {
    throw new Error('Inspector WebSocket must belong to the owned loopback port')
  }
  return url.href
}

export async function connectCdp(url, { port, timeoutMs = 5000, signal } = {}) {
  if (typeof WebSocket !== 'function') throw new Error('Node with built-in WebSocket is required (Node 24)')
  signal?.throwIfAborted()
  const socket = new WebSocket(inspectorSocket(url, port))
  const pending = new Map()
  let nextId = 0
  let closed = false
  const fail = () => {
    closed = true
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('CDP connection closed'))
    }
    pending.clear()
  }
  const close = () => {
    fail()
    signal?.removeEventListener('abort', close)
    socket.close()
  }
  socket.addEventListener('close', fail)
  socket.addEventListener('error', fail)
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) { close(); return }
    let message
    try { message = JSON.parse(event.data) } catch { close(); return }
    const entry = pending.get(message.id)
    if (!entry) return // Deliberately do not collect console/network events or their payloads.
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error('CDP command failed'))
    else entry.resolve(message.result)
  })
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
        signal?.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve()
      }
      const opened = () => finish()
      const failed = () => finish(new Error('CDP connection failed'))
      const aborted = () => finish(new Error('CDP connection aborted'))
      const timer = setTimeout(() => finish(new Error('CDP connection timed out')), timeoutMs)
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', failed)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
    signal?.addEventListener('abort', close, { once: true })
    signal?.throwIfAborted()
    return {
      async send(method, params = {}) {
        signal?.throwIfAborted()
        if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('CDP connection is not open')
        const id = ++nextId
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('CDP command timed out'))
          }, timeoutMs)
          pending.set(id, { resolve, reject, timer })
          try { socket.send(JSON.stringify({ id, method, params })) }
          catch { pending.delete(id); clearTimeout(timer); reject(new Error('CDP send failed')) }
        })
      },
      async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw new Error('Browser evaluation failed (no page content captured)')
        return result.result?.value
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

// Runs before any Chrome spawn: a persistent profile is only ever used if it is a real,
// marked, unlocked directory outside Chrome's own user data.
async function resolvePerfProfile(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Persistent profile directory is required')
  const target = path.resolve(directory)
  refuseChromeUserData(target)
  const info = await entryInfo(target)
  if (!info?.isDirectory()) throw new Error('Persistent profile must be an existing real directory (not a symlink)')
  const real = await realpath(target)
  refuseChromeUserData(real)
  if (!await hasPerfMarker(real)) throw new Error('Persistent profile is missing a valid fx0 performance marker')
  await clearStaleLock(real)
  return real
}

// Chrome leaves SingletonLock (a `<hostname>-<pid>` symlink) behind when it exits. Only a lock
// whose owner PID on this host is gone is stale; any other lock may be a live session, so refuse.
async function clearStaleLock(real) {
  const lock = path.join(real, 'SingletonLock')
  const info = await entryInfo(lock)
  if (!info) return
  const owner = info.isSymbolicLink() ? await readlink(lock).catch(() => '') : ''
  const match = /^(.+)-(\d+)$/.exec(owner)
  if (match?.[1] === hostname()) {
    try { process.kill(Number(match[2]), 0) }
    catch (error) {
      if (error.code === 'ESRCH') { await rm(lock, { force: true }); return }
    }
  }
  throw new Error('Persistent profile is in use by a Chrome process; close that window first')
}

async function chromeExecutable() {
  const configured = process.env.CHROME_PATH
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try { await access(candidate); return candidate } catch { /* Try the next explicit path, never a shell/PATH lookup. */ }
  }
  throw new Error('Chrome not found; set CHROME_PATH to an absolute Chrome executable path')
}

export async function launchChrome({ headless = false, timeoutMs = 15000, signal, profileDirectory } = {}) {
  signal?.throwIfAborted()
  const persistent = profileDirectory == null ? null : await resolvePerfProfile(profileDirectory)
  const executable = await chromeExecutable()
  const profile = persistent ?? await mkdtemp(path.join(tmpdir(), 'fx0-perf-chrome-'))
  // A killed earlier run can leave its DevToolsActivePort behind; never trust it.
  if (persistent) await rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  let child
  let cdp
  let exited = false
  let launchFailed = false
  let exitPromise
  let closing
  let browserSocket
  const close = () => closing ??= (async () => {
    cdp?.close()
    // A persistent profile must close through Chrome itself: its cookie store is flushed
    // in batches, and a signal can end the process before a new sign-in reaches disk.
    if (persistent && browserSocket && child && !exited) {
      try {
        const browser = await connectCdp(browserSocket.url, { port: browserSocket.port, timeoutMs: 2000 })
        await browser.send('Browser.close').catch(() => {})
        browser.close()
        await Promise.race([exitPromise, delay(5000, undefined, { ref: false })])
      } catch {}
    }
    if (child && !exited) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([exitPromise.then(() => true), delay(2000, undefined, { ref: false }).then(() => false)])
      if (!stopped) { child.kill('SIGKILL'); await exitPromise }
    }
    // The owned Chrome is stopped above; a persistent profile is kept for reuse.
    if (!persistent) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })()
  try {
    signal?.throwIfAborted()
    child = spawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      ...(headless ? ['--headless=new'] : []), 'about:blank',
    ], { stdio: 'ignore', shell: false, detached: false })
    exitPromise = new Promise(resolve => {
      child.once('error', () => { launchFailed = true; exited = true; resolve() })
      child.once('exit', () => { exited = true; resolve() })
    })
    const deadline = performance.now() + timeoutMs
    let port
    while (performance.now() < deadline) {
      signal?.throwIfAborted()
      if (exited) throw new Error(launchFailed ? 'Chrome could not start' : 'Chrome exited during startup')
      let active
      try { active = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8') }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read owned DevToolsActivePort') }
      if (active) {
        const [portText, browserPath] = active.trim().split(/\r?\n/)
        if (!/^\d{1,5}$/.test(portText) || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath)) throw new Error('Invalid owned DevToolsActivePort')
        port = Number(portText)
        if (port < 1 || port > 65535) throw new Error('Invalid owned inspector port')
        const version = await inspectorJson(port, '/json/version', { signal, timeoutMs: Math.max(1, deadline - performance.now()) })
        if (inspectorSocket(version.webSocketDebuggerUrl, port) !== `ws://127.0.0.1:${port}${browserPath}`) {
          throw new Error('Inspector does not match the owned DevToolsActivePort')
        }
        browserSocket = { url: `ws://127.0.0.1:${port}${browserPath}`, port }
        break
      }
      await delay(50, undefined, { signal })
    }
    if (!port) throw new Error('Chrome startup timed out waiting for DevToolsActivePort')
    const targets = await inspectorJson(port, '/json/list', { signal, timeoutMs: Math.max(1, deadline - performance.now()) })
    const page = Array.isArray(targets) && targets.find(target => target.type === 'page' && target.url === 'about:blank')
    if (!page) throw new Error('Owned Chrome has no blank page target')
    cdp = await connectCdp(page.webSocketDebuggerUrl, { port, signal, timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now())) })
    return { cdp, close }
  } catch (error) {
    await close()
    throw error
  }
}
