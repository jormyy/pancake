import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { localKeys, sql } from '../../scripts/season-sim/local-stack.mjs'
import { setClock } from '../../scripts/season-sim/clock.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.versions.node.split('.')[0], '22')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))

const file = 'supabase/sql/functions/by-name/public/link_player_sources_atomic.sql'
const reference = execFileSync('git', ['show', `ec739102:${file}`], { encoding: 'utf8' })
const candidate = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
const rows = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('provider_id',espn_id,
  'display_name',display_name,'nba_team',nba_team,'position',position,'years_exp',years_exp) ORDER BY id)
  FROM (SELECT * FROM public.players WHERE espn_id IS NOT NULL AND nba_team IS NOT NULL ORDER BY id LIMIT 100) p`))
assert.ok(rows.length >= 50)
const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
await setClock({ at: '2026-10-29T20:30:00.000Z', install: true, rate: 0 })
const literal = value => `'${value.replaceAll("'", "''")}'`
const rounds = []
const fingerprint = `SELECT jsonb_build_object('players',md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'')),
  'receipts',(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY ordinal)::text) FROM l4c_receipts r)) FROM public.players p`
try {
for (let round = -1; round < 5; round++) {
  for (const variant of round % 2 === 0 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
    const output = await sql(`BEGIN;
      SET LOCAL statement_timeout='120s';
      ${variant === 'reference' ? reference : candidate}
      EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
      CREATE TEMP TABLE l4c_receipts ON COMMIT DROP AS
      SELECT ordinal,public.link_player_sources_atomic('espn',jsonb_build_array(record),false) AS result
      FROM jsonb_array_elements(${literal(JSON.stringify(rows))}::jsonb) WITH ORDINALITY incoming(record,ordinal);
      ${fingerprint};
      ROLLBACK;`)
    const boundary = output.lastIndexOf('\n{')
    assert.ok(boundary > 0, output.slice(-500))
    const plan = JSON.parse(output.slice(0, boundary))[0]
    const hash = JSON.parse(output.slice(boundary + 1))
    if (round >= 0) rounds.push({ round, variant, calls: rows.length, databaseMs: plan['Execution Time'], buffers: plan.Plan['Shared Hit Blocks'], walBytes: plan.Plan['WAL Bytes'], hash })
  }
}
for (let round = 0; round < 5; round++) {
  assert.deepEqual(rounds.filter(row => row.round === round).map(row => row.hash)[0], rounds.filter(row => row.round === round).map(row => row.hash)[1])
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summary = Object.fromEntries(['reference', 'candidate'].map(variant => [variant, {
  calls: rows.length,
  medianDatabaseMs: median(rounds.filter(row => row.variant === variant).map(row => row.databaseMs)),
}]))
const result = { source: execFileSync('git', ['-C', new URL('../../', import.meta.url).pathname, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), rounds, summary }
await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
await writeFile(path.join(miniRoot, 'evidence/identity-pairs.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(summary))
} finally {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
