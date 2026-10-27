// EXPERIMENT ONLY: never merge this branch. Measures one proposed libfx change on a
// Vercel preview before it is proposed in vercel-labs/fx (sdk/durable.js).
//
// libfx 0.0.14 reads the session's UI length (the viewer's start) before send() begins,
// adding one serial World round trip to every prompt with an explicit messageId. The
// invariant only needs that read to land before the message is written to the log, and
// before the log read that answers the retry. This patch starts the read alongside
// send()'s own session open and log read, and waits for it right before the first write.
// If the read fails, nothing is written, exactly as before.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// libfx does not export its package.json, so resolve it from this project's node_modules.
const root = fileURLToPath(new URL('../node_modules/libfx/', import.meta.url))
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (version !== '0.0.14') throw new Error(`patch-libfx-experiment targets libfx 0.0.14, found ${version}`)

const file = path.join(root, 'durable.js')
const marker = '// fx0 experiment: viewer start overlaps send'
let source = readFileSync(file, 'utf8')
if (source.includes(marker)) {
  console.log('libfx viewer-start experiment already applied')
  process.exit(0)
}

const replacements = [
  [
    '      const send = async (message, { inRequest = false } = {}) => {\n',
    `      ${marker}\n      const send = async (message, { inRequest = false, viewerStart = null } = {}) => {\n`,
  ],
  [
    '        await recordMessage(log, foldSessionLog(await log.read()), full);\n',
    '        const known = foldSessionLog(await log.read());\n' +
    '        // The caller\'s viewer start lands before anything is written.\n' +
    '        if (viewerStart) await viewerStart;\n' +
    '        await recordMessage(log, known, full);\n',
  ],
  [
    '                from = await log.ui.length();\n' +
    '                const [state] = await Promise.all([\n' +
    '                  log.read().then(foldSessionLog),\n' +
    '                  send({ type, messageId, ...(input === undefined ? {} : { input }) }, { inRequest: type === "prompt" }).then(() => accept.resolve({ messageId, sessionId })),\n' +
    '                ]);\n',
    '                // The viewer\'s start is still read before the retry answer\'s log read\n' +
    '                // and before send() writes anything; send() opens and reads alongside it.\n' +
    '                const viewerStart = log.ui.length();\n' +
    '                void viewerStart.catch(() => {});\n' +
    '                const [state] = await Promise.all([\n' +
    '                  viewerStart.then(() => log.read()).then(foldSessionLog),\n' +
    '                  send({ type, messageId, ...(input === undefined ? {} : { input }) }, { inRequest: type === "prompt", viewerStart }).then(() => accept.resolve({ messageId, sessionId })),\n' +
    '                ]);\n' +
    '                from = await viewerStart;\n',
  ],
]

for (const [before, after] of replacements) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`patch-libfx-experiment: expected one match, found ${count}`)
  source = source.replace(before, after)
}
writeFileSync(file, source)
console.log('libfx viewer-start experiment applied to', path.relative(process.cwd(), file))
