import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

test('Chrome exports correlated draft spans without recording the generated HTML', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'fx0-trace-browser-'))
  const modules = new Map()
  for (const name of ['trace-browser', 'performance-trace', 'prompt-trace', 'draft-preview']) {
    const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8')
    modules.set(`/${name}.js`, stripTypeScriptTypes(source)
      .replaceAll("'./performance-trace'", "'./performance-trace.js'")
      .replaceAll("'./prompt-trace'", "'./prompt-trace.js'")
      .replaceAll('process.env.NEXT_PUBLIC_FX0_TRACE_SCOPE', "'local'")
      .replaceAll('process.env.NEXT_PUBLIC_FX0_TRACE', "'1'"))
  }
  const server = createServer((request, response) => {
    if (modules.has(request.url)) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(modules.get(request.url))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body><pre id="out">pending</pre>
      <script type="module">
      import {initBrowserTracing,beginBrowserPrompt,correlateBrowserEvent,traceBrowser,traceBrowserEvent} from '/trace-browser.js';
      import {patchDraftDocument} from '/draft-preview.js';
      initBrowserTracing();
      const session='00000000-0000-4000-8000-000000000001';
      const id=beginBrowserPrompt(session);
      const context=correlateBrowserEvent(session,{type:'user',id:1,text:'private prompt'},id);
      const doc=document.implementation.createHTMLDocument('draft');
      patchDraftDocument(doc,'<!doctype html><html><body><h1>private generated design</h1></body></html>',context,traceBrowser);
      traceBrowserEvent('preview.presented',context,{revision:1});
      const snapshot=window.__fx0Trace.snapshot();
      document.getElementById('out').textContent=JSON.stringify({snapshot,heading:doc.querySelector('h1').textContent});
      </script></body></html>`)
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const { stdout } = await promisify(execFile)(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', `--user-data-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom',
      `http://127.0.0.1:${server.address().port}/`], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    const match = stdout.match(/<pre id="out">([^<]+)<\/pre>/)
    assert.ok(match, 'the browser returned the trace probe')
    const { snapshot, heading } = JSON.parse(match[1])
    assert.equal(heading, 'private generated design')
    assert.deepEqual(snapshot.traceEvents.filter(event => event.name !== 'browser.longtask').map(event => event.name),
      ['prompt.started', 'draft.sanitize', 'draft.patch', 'preview.presented'])
    for (const event of snapshot.traceEvents.filter(event => !['browser.longtask', 'prompt.started'].includes(event.name))) {
      assert.match(event.args.traceId, /^[a-f0-9]{32}$/)
      assert.equal(event.args.sessionId, '00000000-0000-4000-8000-000000000001')
      assert.equal(event.args.turnId, 1)
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /private generated design|private prompt/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(profile, { recursive: true, force: true })
  }
})
