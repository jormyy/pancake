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
const file = 'supabase/sql/functions/by-name/public/resolve_player_imports_atomic.sql'
const reference = execFileSync('git', ['show', `ec739102:${file}`], { encoding: 'utf8' })
const candidate = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
const records = JSON.parse(await sql(`WITH selected AS (
  SELECT g.* FROM public.nba_games g WHERE (SELECT count(*) FROM private.player_game_memberships m
    JOIN public.players p ON p.id=m.player_id WHERE m.game_id=g.id AND m.nba_team IS NOT NULL
      AND p.nba_id IS NOT NULL AND p.nba_id NOT IN ('196295686','1641794'))>=20
  ORDER BY g.game_date DESC,g.id LIMIT 1)
  SELECT jsonb_agg(jsonb_build_object('provider_id',p.nba_id,'display_name',p.display_name,
    'nba_game_id',g.nba_game_id,'nba_team',m.nba_team,'identity_only',true) ORDER BY p.id)
  FROM selected g JOIN private.player_game_memberships m ON m.game_id=g.id JOIN public.players p ON p.id=m.player_id
  WHERE p.nba_id IS NOT NULL AND m.nba_team IS NOT NULL AND p.nba_id NOT IN ('196295686','1641794')`))
assert.ok(records.length >= 20)
const literal = `'${JSON.stringify(records).replaceAll("'", "''")}'::jsonb`
const rounds = []
const boxes = 100
await setClock({ at: '2026-10-29T20:30:00.000Z', install: true, rate: 0 })
try {
  for (let round = -1; round < 5; round++) {
    for (const variant of round % 2 === 0 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
      const output = await sql(`BEGIN;
        ${variant === 'reference' ? reference : candidate}
        EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
        CREATE TEMP TABLE l4c_receipts ON COMMIT DROP AS
        SELECT frame,public.resolve_player_imports_atomic('nba_cdn',${literal}) AS receipt FROM generate_series(1,${boxes}) frame;
        SELECT jsonb_build_object('players',(SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM public.players p),
          'memberships',(SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY game_id,player_id)::text) FROM private.player_game_memberships m),
          'receipts',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY frame)::text) FROM l4c_receipts r));
        ROLLBACK;`)
      const boundary = output.lastIndexOf('\n{')
      const plan = JSON.parse(output.slice(0, boundary))[0]
      const hash = JSON.parse(output.slice(boundary + 1))
      if (round >= 0) rounds.push({ round, variant, calls: boxes, databaseMs: plan['Execution Time'], hash })
    }
  }
  for (let round = 0; round < 5; round++) {
    const pair = rounds.filter(row => row.round === round)
    assert.deepEqual(pair[0].hash, pair[1].hash)
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(['reference', 'candidate'].map(variant => [variant,
    median(rounds.filter(row => row.variant === variant).map(row => row.databaseMs))]))
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await writeFile(path.join(miniRoot, 'evidence/cdn-known-pairs.json'), `${JSON.stringify({ players: records.length, boxes, rounds, summary }, null, 2)}\n`)
  console.log(JSON.stringify(summary))
} finally {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
