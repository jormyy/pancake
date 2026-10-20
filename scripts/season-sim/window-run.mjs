import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { delay, miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { setClock } from './clock.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'

const context = JSON.parse(await readFile(path.join(miniRoot, 'state/league.json'), 'utf8'))
const at = '2026-02-28T02:25:59.999Z'
const capAt = '2026-02-28T02:29:00.000Z'
const runtime = await startRuntime(at)
try {
  await setClock({ at, rate: 20, capAt })
  const live = await dispatch("SELECT public.invoke_edge_function('live-poll')")
  await delay(13000)
  const database = JSON.parse(await sql("SELECT json_build_object('now',extract(epoch FROM now())*1000,'clock',extract(epoch FROM clock_timestamp())*1000,'transaction',extract(epoch FROM transaction_timestamp())*1000,'statement',extract(epoch FROM statement_timestamp())*1000)"))
  for (const value of Object.values(database)) assert.equal(value, Date.parse(capAt))
  const edge = await (await fetch('http://127.0.0.1:56281/health')).json()
  assert.equal(edge.at, capAt)
  await setClock({ at: capAt, rate: 0 })
  const preTip = await dispatch('SELECT public.invoke_pre_tipoff_optimizer_if_due()')
  await setClock({ at: '2026-02-28T09:00:00Z', rate: 0 })
  const final = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"2026-02-27"}'); SELECT public.invoke_edge_function('sync-scores','{"date":"2026-02-27T20:00:00Z"}')`)
  const finals = await assertFinals('2026-02-27')
  const points = await assertLeaguePoints({ ...context, date: '2026-02-27', allowEmptyLineups: true })
  const result = { at, capAt, live, database, edge: { at: edge.at, active: edge.active }, preTip, final, finals, points, passed: true, scope: 'Saved-state clock boundary check with a synthetic 13-second harness delay; separate from monotonic season acceptance' }
  await writeJson(path.join(miniRoot, 'evidence/sim-h010-replay-green.json'), result)
  console.log(JSON.stringify(result))
} finally { await runtime.close() }
