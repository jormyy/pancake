import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { setClock } from './clock.mjs'
import { dispatch } from './dispatch.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'

const context = JSON.parse(await readFile(path.join(miniRoot, 'state/league.json'), 'utf8'))
const at = '2025-12-07T02:10:00.000Z'
const runtime = await startRuntime(at)
try {
  await setClock({ at, rate: 20 })
  const live = await dispatch('SELECT public.invoke_live_poll_if_due()')
  await setClock({ at: '2025-12-07T09:00:00Z', rate: 0 })
  const final = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"2025-12-06"}'); SELECT public.invoke_edge_function('sync-scores','{"date":"2025-12-06T20:00:00Z"}')`)
  const finals = await assertFinals('2025-12-06')
  const points = await assertLeaguePoints({ ...context, date: '2025-12-06', allowEmptyLineups: true })
  const result = { at, live, final, finals, points, passed: true, scope: 'Focused deadline regression on saved failed state; separate from monotonic season acceptance' }
  await writeJson(path.join(miniRoot, 'evidence/sim-h007-replay-green.json'), result)
  console.log(JSON.stringify(result))
} finally { await runtime.close() }
