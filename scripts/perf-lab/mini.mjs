import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { json, labRoot, requireMini } from './common.mjs'
import { preflight } from './preflight.mjs'
import { withDatabase } from './setup.mjs'
import { runLab } from './lab.mjs'
import { ensureMkcert } from './build.mjs'
import { checkIdentity } from './identity-check.mjs'
import { captureConsole } from './bounded-log.mjs'

export async function main(mode, limit) {
  await requireMini()
  if (mode === 'capture-test') { await import('../../tests/perf-lab/capture-smoke.mjs'); return }
  if (!['preflight', 'database', 'identity-test', 'all', 'walk', 'replay'].includes(mode)) throw new Error('Unknown lab mode')
  if (['all', 'walk'].includes(mode) && process.env.PERF_LAB_TLS_SELF_SIGNED !== '1') await ensureMkcert()
  const result = await preflight({ full: !['database', 'identity-test'].includes(mode) })
  await json(path.join(labRoot, 'evidence/preflight.json'), result)
  console.log(JSON.stringify({ checks: result.checks, passed: result.passed }))
  if (!result.passed) { process.exitCode = 1; return }
  if (mode === 'database') await withDatabase(async () => console.log('Database restoration and statement capture are ready.'))
  if (mode === 'identity-test') await withDatabase(async ({ evidence }) => {
    console.log(await checkIdentity('linked', evidence))
  })
  if (['all', 'walk', 'replay'].includes(mode)) await runLab({ limit, screens: mode !== 'replay', simulation: mode !== 'walk' })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const consoleLog = captureConsole()
  try { await main(process.argv[2] ?? 'all', process.argv[3] === undefined ? Infinity : Number(process.argv[3])) }
  finally { await json(path.join(labRoot, 'evidence/console-output.json'), consoleLog.close()) }
}
