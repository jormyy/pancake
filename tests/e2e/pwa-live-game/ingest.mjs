import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { command } from '../../../scripts/perf-lab/process.mjs'
import { localKeys, sql } from './database.mjs'
import { labRoot } from './common.mjs'

const keys = await localKeys()
const client = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const fixture = JSON.parse(await readFile(path.join(labRoot, 'seed/complete.json'), 'utf8'))
const { data: game, error } = await client.from('nba_games').select('*').eq('nba_game_id', '0022609002').single()
assert.equal(error, null)
const { data: lines, error: lineError } = await client.from('player_game_stats').select('*').eq('game_id', game.id)
assert.equal(lineError, null)
assert.ok(lines.length)
const tick = Math.max(Number(process.argv[2] ?? 1), Number(game.live_stats_elapsed_seconds ?? 1200) - 1200 + 1)
const snapshot = {
    source: 'nba', source_updated_at: new Date().toISOString(), elapsed_seconds: 1200 + tick,
    status: 'InProgress', home_score: 64 + tick, away_score: 61 + tick, status_text: 'Q3 08:00',
    stats: lines.map((line, index) => ({ ...line, points: 20 + (index % 5) + tick, minutes_played: 20 + tick / 60 })),
}
const began = Date.now()
const { data, error: ingestError } = await client.rpc('save_live_feed_snapshot_atomic', { p_game_id: game.id, p_provider_game_id: game.nba_game_id, p_snapshot: snapshot })
assert.equal(ingestError, null)
assert.ok(data > 0, 'Live ingest must change box score rows')
await command('deno', ['run', '--cached-only', '--node-modules-dir=manual', '--allow-env', '--allow-read', '--allow-net=127.0.0.1:64921', 'tests/e2e/pwa-live-game/score.mjs', fixture.leagueId], {
    env: { ...process.env, SUPABASE_URL: keys.API_URL, PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY }, timeout: 60000,
})
const totals = await sql(`SELECT json_build_object('leagueId','${fixture.leagueId}','tick',${tick},'ingestedAt',${began},'rows',${data},'points',(SELECT json_agg(json_build_object('home',home_member_id,'away',away_member_id,'homePoints',home_points,'awayPoints',away_points)) FROM matchups WHERE league_id='${fixture.leagueId}' AND week_number=${fixture.currentWeek}),'scoreVersion',(SELECT version::text FROM league_versions WHERE league_id='${fixture.leagueId}'))`)
await appendFile(path.join(labRoot, 'evidence/ingest-ticks.jsonl'), `${JSON.stringify(JSON.parse(totals))}\n`)
console.log(totals)
