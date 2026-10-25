import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { setClock } from './clock.mjs'
import { clockTime } from './virtual-clock.mjs'
import { dispatch } from './dispatch.mjs'

const saved = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
const at = clockTime(saved, Date.now())
const report = { scope: 'One retained-state production gate retry; does not prove a fresh replay', startedAt: new Date().toISOString(), at: new Date(at).toISOString(), passed: false }
let runtime
try {
  runtime = await startRuntime(report.at, { resume: true })
  process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
  await setClock({ at: report.at, rate: 100, capAt: new Date(at + 120000).toISOString() })
  report.outcomes = await dispatch('SELECT public.invoke_live_poll_if_due()')
  report.passed = true
} catch (error) {
  report.failure = { name: error.name, message: error.message }
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  report.seconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000
  await writeJson(path.join(miniRoot, 'evidence/gate-probe.json'), report)
  await runtime?.close()
}
