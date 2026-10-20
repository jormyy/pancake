import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { setClock } from './clock.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'

const context = /** @type {(text: string | Buffer) => any} */ (JSON.parse)(await readFile(path.join(miniRoot, 'state/league.json')))
const at = '2026-01-22T02:20:00Z'
const runtime = await startRuntime(at)
try {
  await setClock({ at, rate: 20 })
  const live = await dispatch('SELECT public.invoke_live_poll_if_due()', { optional: true })
  await setClock({ at: '2026-01-23T09:00:00Z', rate: 0 })
  const final = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"2026-01-21"}'); SELECT public.invoke_edge_function('sync-scores','{"date":"2026-01-21T20:00:00Z"}')`)
  const finals = await assertFinals('2026-01-21')
  const points = await assertLeaguePoints({ ...context, date: '2026-01-21', allowEmptyLineups: true })
  const identities = JSON.parse(await sql("SELECT json_agg(p) FROM (SELECT display_name,nba_id,espn_id FROM players WHERE display_name='Dillon Jones' OR nba_id='196295686') p"))
  assert.equal(identities.length, 1)
  assert.equal(identities[0].nba_id, '1641794')
  const result = { at, live, final, finals, points, identities, passed: true, scope: 'Focused identity regression on saved state; separate from season acceptance' }
  await writeJson(path.join(miniRoot, 'evidence/sim-b007-replay-green.json'), result)
  console.log(JSON.stringify(result))
} finally { await runtime.close() }
