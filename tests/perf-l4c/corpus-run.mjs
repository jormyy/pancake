import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { createSqlSession } from '../../scripts/season-sim/sql-session.mjs'
import { virtualDate } from '../../scripts/season-sim/virtual-clock.mjs'

const Deno = globalThis['Deno']
const root = Deno.env.get('SEASON_SIM_ROOT')
const clockFile = `${root}/state/clock.json`
const NativeDate = Date
globalThis.Date = virtualDate(NativeDate, () => JSON.parse(readFileSync(clockFile, 'utf8')))
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  assert.ok(['http://127.0.0.1:63021', 'http://127.0.0.1:63080'].includes(url.origin))
  return nativeFetch(request)
}
const session = createSqlSession('psql', Object.fromEntries(['PATH', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPASSFILE', 'PGSSLMODE'].map(key => [key, Deno.env.get(key)])))
const source = file => pathToFileURL(`${Deno.args[0]}/supabase/functions/${file}`).href
const { supabase } = await import(source('_shared/supabase.ts'))
const { withWorkContext } = await import(source('_shared/workContext.ts'))
const { ingestTick } = await import(source('live-poll/runner.ts'))
const { LIVE_POLL_LOCK_KEY, LIVE_POLL_LEASE_TTL_SECONDS } = await import(source('_shared/livePoll.ts'))
const { syncStatsForDates } = await import(source('_shared/syncStats.ts'))
const { syncInjuries } = await import(source('sync-players/injuries.ts'))
const { linkPlayerSources } = await import(source('_shared/sourceLinks.ts'))
const days = new Set()
const injuries = []
const frames = JSON.parse(Deno.args[1])
try {
  for (const [index, at] of frames.entries()) {
    await session.query(`UPDATE season_sim.clock SET sim_ms=${at},rate=0 WHERE singleton`)
    writeFileSync(clockFile, `${JSON.stringify({ simMs: at, realMs: NativeDate.now(), rate: 0, capMs: null })}\n`)
    const day = new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    if (!days.has(day)) {
      days.add(day)
      const records = JSON.parse(await session.query("SELECT jsonb_agg(jsonb_build_object('provider_id',espn_id,'display_name',display_name,'nba_team',nba_team) ORDER BY id) FROM public.players WHERE espn_id IS NOT NULL AND nba_team IS NOT NULL"))
      await linkPlayerSources(supabase, 'espn', records)
      injuries.push({ day, ...await syncInjuries() })
    }
    const { data: holder, error } = await supabase.rpc('try_live_poll_lease', { p_lock_key: LIVE_POLL_LOCK_KEY, p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS })
    if (error) throw error
    assert.ok(holder, 'The isolated corpus tick must hold its lease')
    try {
      const tick = await withWorkContext({ livePollHolder: holder, signal: AbortSignal.timeout(18000) }, () => ingestTick(holder))
      assert.deepEqual(tick.failures, [])
    } finally {
      const { error } = await supabase.rpc('release_live_poll_lease', { p_lock_key: LIVE_POLL_LOCK_KEY, p_holder_id: holder })
      if (error) throw error
    }
    if (index % 100 === 0) console.log(JSON.stringify({ corpusFrame: index, total: frames.length, at: new Date(at).toISOString() }))
  }
  await syncStatsForDates(['2026-10-29', '2026-10-30'])
  console.log(JSON.stringify({ injuries, frames: frames.length }))
} finally { await session.close() }
