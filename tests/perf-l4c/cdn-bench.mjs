import assert from 'node:assert/strict'
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
const records = JSON.parse(await sql(`WITH selected AS (
  SELECT g.* FROM public.nba_games g WHERE EXISTS(SELECT FROM private.player_game_memberships m WHERE m.game_id=g.id)
  ORDER BY g.game_date DESC,g.id LIMIT 1)
  SELECT jsonb_agg(jsonb_build_object('provider_id',p.nba_id,'display_name',p.display_name,
    'nba_game_id',g.nba_game_id,'nba_team',coalesce(m.nba_team,g.home_team),'identity_only',true) ORDER BY p.id)
  FROM selected g JOIN private.player_game_memberships m ON m.game_id=g.id JOIN public.players p ON p.id=m.player_id
  WHERE p.nba_id IS NOT NULL`))
assert.ok(records.length >= 10)
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const minimal = records.map(({ provider_id, display_name, nba_game_id, identity_only }) => ({ provider_id, display_name, nba_game_id, identity_only }))
const rounds = []
const boxes = 100
await setClock({ at: '2026-10-29T20:30:00.000Z', install: true, rate: 0 })
try {
  for (let round = -1; round < 5; round++) {
    for (const variant of round % 2 === 0 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
      const output = await sql(`BEGIN;
        EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
        CREATE TEMP TABLE l4c_receipts ON COMMIT DROP AS
        WITH sides AS MATERIALIZED (SELECT frame,public.resolve_player_imports_atomic('nba_cdn',${literal(records)}) AS receipt
          FROM generate_series(1,${boxes}) frame)
        SELECT frame,receipt,${variant === 'reference' ? `public.resolve_player_imports_atomic('nba_cdn',${literal(minimal)})` : 'receipt'} AS resolved FROM sides;
        SELECT jsonb_build_object('players',(SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM public.players p),
          'memberships',(SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY game_id,player_id)::text) FROM private.player_game_memberships m),
          'receipts',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY frame)::text) FROM l4c_receipts r));
        ROLLBACK;`)
      const boundary = output.lastIndexOf('\n{')
      const plan = JSON.parse(output.slice(0, boundary))[0]
      const hash = JSON.parse(output.slice(boundary + 1))
      if (round >= 0) rounds.push({ round, variant, calls: boxes * (variant === 'reference' ? 2 : 1), databaseMs: plan['Execution Time'], hash })
    }
  }
  for (let round = 0; round < 5; round++) {
    const pair = rounds.filter(row => row.round === round)
    assert.deepEqual(pair[0].hash, pair[1].hash)
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(['reference', 'candidate'].map(variant => [variant, {
    calls: boxes * (variant === 'reference' ? 2 : 1),
    medianDatabaseMs: median(rounds.filter(row => row.variant === variant).map(row => row.databaseMs)),
  }]))
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await writeFile(path.join(miniRoot, 'evidence/cdn-pairs.json'), `${JSON.stringify({ boxes, players: records.length, rounds, summary }, null, 2)}\n`)
  console.log(JSON.stringify(summary))
} finally {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
