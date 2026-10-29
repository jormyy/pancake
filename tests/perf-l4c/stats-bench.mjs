import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { localKeys, sql } from '../../scripts/season-sim/local-stack.mjs'
import { setClock } from '../../scripts/season-sim/clock.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
const source = 'supabase/sql/functions/by-name/public/save_game_stats_atomic.sql'
const reference = execFileSync('git', ['show', `ec739102:${source}`], { encoding: 'utf8' })
const candidate = await readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../', source), 'utf8')
const input = JSON.parse(await sql(`SELECT jsonb_build_object('game',to_jsonb(g),'stats',
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) FROM public.player_game_stats s WHERE s.game_id=g.id))
  FROM public.nba_games g WHERE (SELECT count(*) FROM public.player_game_stats s WHERE s.game_id=g.id)>=20
  ORDER BY game_date DESC,id LIMIT 1`))
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const quote = value => `'${value.replaceAll("'", "''")}'`
const ticks = 50
const mixedPlayers = 10
const rounds = []
await setClock({ at: '2026-10-29T20:30:00.000Z', install: true, rate: 0 })
try {
  for (const scenario of ['unchanged', 'mixed', 'changed']) {
    for (let round = -1; round < 5; round++) {
      for (const variant of round % 2 === 0 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
        const payload = scenario === 'unchanged' ? literal(input.stats)
          : `(SELECT jsonb_agg(CASE WHEN ${scenario === 'changed' ? 'true' : `ordinal<=${mixedPlayers}`}
            THEN jsonb_set(row,'{points}',to_jsonb((row->>'points')::integer+frame)) ELSE row END ORDER BY ordinal)
            FROM jsonb_array_elements(${literal(input.stats)}) WITH ORDINALITY incoming(row,ordinal))`
        const output = await sql(`BEGIN;
          SET LOCAL statement_timeout='120s';
          ${variant === 'reference' ? reference : candidate}
          DELETE FROM private.game_stat_revisions WHERE game_id=${quote(input.game.id)};
          UPDATE public.nba_games SET status='InProgress',stats_synced_at=NULL,live_stats_elapsed_seconds=0 WHERE id=${quote(input.game.id)};
          EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
          CREATE TEMP TABLE l4c_receipts ON COMMIT DROP AS
          SELECT frame,public.save_live_game_stats_atomic(${quote(input.game.id)},${quote(input.game.nba_game_id)},${payload},frame*20) AS changed
          FROM generate_series(1,${ticks}) frame;
          SELECT jsonb_build_object(
            'players',(SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM public.players p),
            'games',(SELECT md5(jsonb_agg(to_jsonb(g) ORDER BY id)::text) FROM public.nba_games g),
            'stats',(SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY player_id)::text) FROM public.player_game_stats s WHERE game_id=${quote(input.game.id)}),
            'totals',(SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY player_id,season_year)::text) FROM analytics.player_season_totals t),
            'receipts',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY frame)::text) FROM l4c_receipts r),
            'changed',(SELECT sum(changed) FROM l4c_receipts));
          ROLLBACK;`)
        const boundary = output.lastIndexOf('\n{')
        const planStart = output.indexOf('[\n')
        const plan = JSON.parse(output.slice(planStart, boundary))[0]
        const hash = JSON.parse(output.slice(boundary + 1))
        assert.equal(hash.changed, ticks * (scenario === 'unchanged' ? 0 : scenario === 'mixed' ? mixedPlayers : input.stats.length))
        if (round >= 0) rounds.push({ scenario, round, variant, calls: ticks, databaseMs: plan['Execution Time'], buffers: plan.Plan['Shared Hit Blocks'], walBytes: plan.Plan['WAL Bytes'], hash })
      }
    }
  }
  for (const scenario of ['unchanged', 'mixed', 'changed']) {
    for (let round = 0; round < 5; round++) {
      const pair = rounds.filter(row => row.scenario === scenario && row.round === round)
      assert.deepEqual(pair[0].hash, pair[1].hash)
    }
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(['unchanged', 'mixed', 'changed'].map(scenario => [scenario,
    Object.fromEntries(['reference', 'candidate'].map(variant => [variant,
      median(rounds.filter(row => row.scenario === scenario && row.variant === variant).map(row => row.databaseMs))]))]))
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await writeFile(path.join(miniRoot, 'evidence/stats-pairs.json'), `${JSON.stringify({ players: input.stats.length, mixedPlayers, ticks, rounds, summary }, null, 2)}\n`)
  console.log(JSON.stringify(summary))
} finally {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
