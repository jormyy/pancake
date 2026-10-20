import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { clockTime } from './virtual-clock.mjs'
import { dispatch } from './dispatch.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'

const state = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
const context = JSON.parse(await readFile(path.join(miniRoot, 'state/league.json'), 'utf8'))
const at = new Date(clockTime(state, Date.now()) + 31 * 60000).toISOString()
const runtime = await startRuntime(at)
try {
  await writeJson(path.join(miniRoot, 'state/fault.json'), {})
  const outcomes = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"2025-11-04"}'); SELECT public.invoke_edge_function('sync-scores','{"date":"2025-11-04T20:00:00Z"}')`)
  const finals = await assertFinals('2025-11-04')
  const points = await assertLeaguePoints({ ...context, date: '2025-11-04', allowEmptyLineups: true })
  const result = { at, outcomes, finals, points, passed: true, scope: 'Focused real-pipeline regression, separate from season acceptance' }
  await writeJson(path.join(miniRoot, 'evidence/sim-b006-replay-green.json'), result)
  console.log(JSON.stringify(result))
} finally { await runtime.close() }
