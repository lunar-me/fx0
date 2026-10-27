import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const configUrl = new URL('../next.config.mjs', import.meta.url).href
const inspect = `
  let config = (await import(${JSON.stringify(configUrl)})).default;
  if (typeof config === 'function') config = await config('phase-production-build', { defaultConfig: {} });
  process.stdout.write(JSON.stringify({ flag: config.env.NEXT_PUBLIC_FX0_TRACE, scope: config.env.NEXT_PUBLIC_FX0_TRACE_SCOPE }));
`
const cases = [
  ['default off', {}, '0', 'off'],
  ['local opt-in', { FX0_TRACE: '1' }, '1', 'local'],
  ['local flag does not enable preview', { VERCEL: '1', VERCEL_ENV: 'preview', FX0_TRACE: '1' }, '0', 'off'],
  ['explicit preview opt-in', { VERCEL: '1', VERCEL_ENV: 'preview', FX0_TRACE_PREVIEW: '1' }, '1', 'preview'],
  ['production stays off with every flag', { VERCEL: '1', VERCEL_ENV: 'production', FX0_TRACE: '1', FX0_TRACE_PREVIEW: '1' }, '0', 'off'],
  ['production designation stays off without a deployment marker', { VERCEL_ENV: 'production', FX0_TRACE: '1', FX0_TRACE_PREVIEW: '1' }, '0', 'off'],
]

for (const [name, flags, flag, scope] of cases) {
  test(`Next build trace gates: ${name}`, async () => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', inspect], {
      env: { ...process.env, VERCEL: '', VERCEL_ENV: 'development', FX0_TRACE: '', FX0_TRACE_PREVIEW: '', ...flags },
    })
    assert.deepEqual(JSON.parse(stdout), { flag, scope })
  })
}
