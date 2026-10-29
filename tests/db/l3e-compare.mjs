import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { command } from '../../scripts/perf-lab/process.mjs'
import { labRoot, project, requireMini, json } from '../../scripts/perf-lab/common.mjs'
import { scanPlans } from './l3e-plan-audit.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
const [workloadFile, candidateFile, label] = process.argv.slice(2)
assert.match(label, /^[a-z0-9-]+$/)
const workload = JSON.parse(await readFile(workloadFile, 'utf8'))
const candidate = (await readFile(candidateFile, 'utf8')).replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '')
const files = [...new Set([...candidate.matchAll(/CREATE OR REPLACE FUNCTION (?:(\w+)\.)?(\w+)\(/g)].map(match => `${match[1] ?? 'public'}/${match[2]}.sql`))]
let baseline = ''
for (const file of files) baseline += (await command('git', ['show', `${workload.base ?? 'ec739102'}:supabase/sql/functions/by-name/${file}`])).stdout + '\n'
const versions = { baseline, candidate }
const run = input => command('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, timeout: 240000, label: 'L3e paired comparison' })
const statistics = `SELECT jsonb_build_object('statistics',COALESCE(jsonb_agg(to_jsonb(t)),'[]')) FROM (SELECT relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch FROM pg_stat_xact_user_tables WHERE relname IN ('player_game_stats','players','player_season_totals','job_run_details','work_items','forecast_player_history','roster_players')) t;`
const samples = [], traces = []
for (let round = 0; round < 5; round++) for (const row of workload.cases) for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
  const setup = `BEGIN; SET LOCAL statement_timeout='120s'; SET LOCAL auto_explain.log_min_duration=-1; SET LOCAL pg_stat_statements.track='none'; ${versions[version]} ${row.setup ?? ''}`
  const repetitions = row.repetitions ?? workload.repetitions ?? 1
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 1000)
  const repeated = `CREATE FUNCTION pg_temp.l3e_repeat() RETURNS integer LANGUAGE plpgsql AS $repeat$ BEGIN FOR i IN 1..${repetitions} LOOP PERFORM * FROM (${row.query.replace(/;\s*$/, '')}) q; END LOOP; RETURN ${repetitions}; END $repeat$;`
  const fingerprint = `SELECT jsonb_build_object('fingerprint',md5(COALESCE(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text)::text,'null'))) FROM (${row.query}) q;`
  const output = await run(`${setup} SAVEPOINT sample;
${fingerprint}
${row.state ? `SELECT jsonb_build_object('state',(${row.state}));` : ''}
ROLLBACK TO SAVEPOINT sample;
${repetitions > 1 ? repeated : ''}
${statistics}
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) ${repetitions > 1 ? 'SELECT pg_temp.l3e_repeat()' : row.query};
${statistics}
ROLLBACK;`)
  const values = output.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  const start = output.stdout.indexOf('[\n'), end = output.stdout.lastIndexOf('\n]')
  assert.ok(start >= 0 && end > start, 'Missing EXPLAIN JSON')
  const plan = JSON.parse(output.stdout.slice(start, end + 2))[0]
  const stats = values.filter(value => value.statistics).map(value => value.statistics)
  assert.equal(stats.length, 2)
  const delta = stats[1].map(after => {
    const before = stats[0].find(value => value.relname === after.relname)
    return { table: after.relname, ...Object.fromEntries(['seq_scan', 'seq_tup_read', 'idx_scan', 'idx_tup_fetch'].map(key => [key, (Number(after[key]) - Number(before[key])) / repetitions])) }
  })
  const sample = { round, name: row.name, version, fingerprint: values.find(value => value.fingerprint)?.fingerprint, state: values.find(value => 'state' in value)?.state, repetitions, planning: plan['Planning Time'] / repetitions, execution: plan['Execution Time'] / repetitions, milliseconds: (plan['Planning Time'] + plan['Execution Time']) / repetitions, buffers: ((plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0)) / repetitions, tables: delta }
  samples.push(sample)
  await json(path.join(labRoot, `${label}-samples.json`), samples)
  console.log(JSON.stringify(sample))
  if (round === 0) {
    const trace = await run(`${setup} LOAD 'auto_explain'; SET LOCAL auto_explain.log_analyze=on; SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off; SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_level=notice; SET LOCAL auto_explain.log_parameter_max_length=0; SET LOCAL auto_explain.sample_rate=1; SET LOCAL auto_explain.log_min_duration=0; ${row.query}; ROLLBACK;`)
    traces.push({ name: row.name, version, scans: scanPlans(trace.stderr), log: trace.stderr })
    await json(path.join(labRoot, `${label}-traces.json`), traces)
  }
}
for (const row of workload.cases) {
  const rows = samples.filter(sample => sample.name === row.name)
  assert.equal(new Set(rows.map(sample => sample.fingerprint)).size, 1, `${row.name}: result bytes differ`)
  assert.equal(new Set(rows.map(sample => JSON.stringify(sample.state))).size, 1, `${row.name}: stored state differs`)
}
const summary = workload.cases.map(row => {
  const versions = Object.fromEntries(['baseline', 'candidate'].map(version => {
    const rows = samples.filter(sample => sample.name === row.name && sample.version === version)
    const sorted = rows.map(row => row.milliseconds).sort((a, b) => a - b)
    return [version, { n: rows.length, medianMs: sorted[2], minMs: sorted[0], maxMs: sorted[4], seqRows: rows[0].tables.reduce((sum, table) => sum + table.seq_tup_read, 0), fetchedRows: rows[0].tables.reduce((sum, table) => sum + table.idx_tup_fetch, 0) }]
  }))
  return { name: row.name, parity: true, ...versions }
})
await json(path.join(labRoot, `${label}-summary.json`), summary)
console.log(JSON.stringify(summary, null, 2))
