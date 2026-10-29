import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  before: { type: 'string' }, after: { type: 'string' }, query: { type: 'string' },
  output: { type: 'string' }, rounds: { type: 'string', default: '5' },
  batch: { type: 'string', default: '20' },
  verify: { type: 'string' },
} })
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablegd')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '631')
const rounds = Number(values.rounds), batch = Number(values.batch)
assert.ok(rounds >= 5 && Number.isInteger(rounds) && batch >= 1 && Number.isInteger(batch))
const query = readFileSync(values.query, 'utf8').trim().replace(/;$/, '')
const verify = values.verify ? readFileSync(values.verify, 'utf8').trim().replace(/;$/, '') : null
const sources = Object.fromEntries(['before', 'after'].map(side => [side, readFileSync(values[side], 'utf8')]))
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafablegd',
  'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
{ input: statement, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
const quote = value => `'${value.replaceAll("'", "''")}'`
const hash = value => createHash('sha256').update(value).digest('hex')
const samples = []
let expected
for (let round = -1; round < rounds; round++) {
  for (const side of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
    const output = sql(`BEGIN;
      SET LOCAL pg_stat_statements.track = 'none';
      ${sources[side]}
      CREATE FUNCTION pg_temp.l4d_measure() RETURNS jsonb LANGUAGE plpgsql AS $bench$
      DECLARE started timestamptz; result jsonb; state jsonb; elapsed numeric; i int;
      BEGIN
        EXECUTE ${quote(query)} INTO result;
        started := clock_timestamp();
        FOR i IN 1..${batch} LOOP EXECUTE ${quote(query)} INTO result; END LOOP;
        elapsed := extract(epoch FROM clock_timestamp()-started)*1000/${batch};
        ${verify ? `EXECUTE ${quote(verify)} INTO state; result := jsonb_build_object('output',result,'stored',state);` : ''}
        RETURN jsonb_build_object('ms', elapsed, 'result', result);
      END $bench$;
      SELECT pg_temp.l4d_measure(); ROLLBACK;`)
    const result = JSON.parse(output)
    const digest = hash(JSON.stringify(result.result))
    expected ??= digest
    assert.equal(digest, expected, `Output changed in ${side} round ${round}`)
    if (round >= 0) samples.push({ round, side, ms: Number(result.ms), digest })
  }
}
const summarize = side => {
  const sorted = samples.filter(row => row.side === side).map(row => row.ms).sort((a, b) => a-b)
  return { n: sorted.length, median: sorted[Math.floor(sorted.length/2)],
    p95: sorted[Math.ceil(sorted.length*0.95)-1], spread: sorted.at(-1)-sorted[0] }
}
const before = summarize('before'), after = summarize('after')
const threshold = Math.max(before.spread, before.median*0.1)
const gain = before.median-after.median
const report = { batch, rounds, querySha256: hash(query), verifySha256: verify ? hash(verify) : null,
  sourceSha256: Object.fromEntries(Object.entries(sources).map(([key,value]) => [key,hash(value)])),
  samples, before, after, threshold, gain, accepted: gain > threshold && after.p95 <= before.p95, parity: true }
writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
