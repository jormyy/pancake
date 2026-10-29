import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { command } from '../../scripts/perf-lab/process.mjs'
import { project } from '../../scripts/perf-lab/common.mjs'

process.env.SCREEN_COST_EVIDENCE = 'slow-screens-evidence'
const { cases, plans, parity, literal, load, save, evidence } = await import('./screen-view-costs.mjs')
const { run, measure, jsonValues } = await import('./unpartition-player-stats.mjs')
assert.equal(project, 'pt4bafablel3d')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const names = ['view_roster', 'view_players', 'view_league', 'view_trades']
const candidateFile = option('candidate') ?? 'supabase/migrations/20261214000500_slow_screens.sql'
const fixture = await load('fixture.json')
fixture.dates[0] = (await run('SELECT max(game_date) FROM public.player_game_stats;')).stdout.trim()
const selected = cases(fixture, process.argv.includes('--variants') || process.argv.includes('--managers')).filter(row => names.includes(row.name) && (!process.argv.includes('--managers') || row.variant === '{}') && (!option('function') || option('function').split(',').includes(row.name))).map(row => ({ ...row, role: 'authenticated', setup: '' }))
const candidate = (await readFile(candidateFile, 'utf8').catch(() => '')).replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '')
const files = [...new Set([...candidate.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(/g)].map(match => `${match[1]}/${match[2]}.sql`))]
const baseline = (await Promise.all(files.map(async file => (await command('git', ['show', `${option('base') ?? '628c7def'}:supabase/sql/functions/by-name/${file}`], { allowFailure: true })).stdout))).join('\n')
const versions = process.argv.includes('--installed') ? { candidate: '' } : candidate ? { baseline, candidate } : { baseline: '' }
const cpus = Number(option('cpus') ?? 1)
assert.ok([1, 0.25].includes(cpus))
await command('docker', ['update', `--cpus=${cpus}`, '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
const limits = await command('docker', ['inspect', '--format', '{{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}}', `supabase_db_${project}`])
assert.equal(limits.stdout.trim(), `${cpus * 1e9} 1073741824`)
const label = option('label') ?? `cpu-${cpus}`

async function quota() {
  const result = await command('docker', ['exec', `supabase_db_${project}`, 'cat', '/sys/fs/cgroup/cpu.stat'])
  return Object.fromEntries(result.stdout.trim().split('\n').map(line => {
    const [key, value] = line.split(/\s+/)
    return [key, Number(value)]
  }))
}

async function trace(row, definition) {
  const statistics = phase => `RESET ROLE;SELECT jsonb_build_object('phase','${phase}','statements',COALESCE(jsonb_agg(to_jsonb(s)),'[]')) FROM (SELECT queryid::text,query,toplevel,plans,calls,total_plan_time,total_exec_time,shared_blks_hit+shared_blks_read AS buffers,rows FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%') s;`
  const result = await run(`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;${definition}
SET LOCAL pg_stat_statements.track='all';SET LOCAL pg_stat_statements.track_planning=on;
LOAD 'auto_explain';SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_level=notice;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.sample_rate=1;
SELECT extensions.pg_stat_statements_reset();SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE authenticated;
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${statistics('fresh')}
SET LOCAL auto_explain.log_min_duration=-1;SET LOCAL ROLE authenticated;
${Array.from({ length: 5 }, () => `SELECT ${row.expression}\n\\g /dev/null\n`).join('')}
RESET ROLE;SELECT extensions.pg_stat_statements_reset();SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE authenticated;
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${statistics('warm')}ROLLBACK;`)
  return { values: jsonValues(result.stdout), nested: plans(result.stderr) }
}

function summarize(samples) {
  const groups = Map.groupBy(samples, row => `${row.name}/${row.variant}/${row.member}/${row.version}/${row.state}/${row.cpus}`)
  return [...groups.values()].map(rows => {
    const distribution = key => {
      const values = rows.map(row => row[key]).sort((a, b) => a - b)
      return { p50: values[Math.floor(rows.length / 2)], p95: values[Math.ceil(rows.length * 0.95) - 1], spread: values.at(-1) - values[0] }
    }
    return { name: rows[0].name, variant: rows[0].variant, member: rows[0].member, version: rows[0].version, state: rows[0].state, cpus: rows[0].cpus, n: rows.length,
      ...Object.fromEntries(['milliseconds', 'planning', 'execution', 'buffers', 'rows'].map(key => [key, distribution(key)])) }
  })
}

async function report() {
  const measurements = summarize([...(await load('final-1-samples.json')), ...(await load('final-quarter-samples.json'))])
  assert.equal(measurements.length, 600)
  assert.ok(measurements.every(row => row.n === 5))
  const misses = measurements.filter(row => row.version === 'candidate' && row.cpus === 1 && row.milliseconds.p95 >= (row.state === 'fresh' ? 150 : 60))
  const comparisons = []
  for (const label of ['count-1', 'trade-block-1', 'projection-1', 'roster-1']) {
    const samples = await load(`${label}-samples.json`).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (samples) comparisons.push({ label, measurements: summarize(samples) })
  }
  const nested = []
  for (const file of (await readdir(evidence)).filter(file => /^final-(1|quarter)-.*-trace.json$/.test(file)).sort()) {
    const data = await load(file)
    assert.ok(data.nested.length > 0)
    for (const value of data.values.filter(value => value.phase)) {
      const statements = value.statements.filter(row => !row.toplevel && !/^EXPLAIN/.test(row.query)).map(row => ({
        query: row.query.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<fixture>'),
        plans: row.plans, calls: row.calls, planning: row.total_plan_time, execution: row.total_exec_time, buffers: row.buffers, rows: row.rows,
      }))
      nested.push({ capture: file, state: value.phase, statements })
    }
  }
  assert.equal(nested.length, 96)
  const parityResults = await load('parity.json')
  const negative = await load('parity-negative.json')
  assert.equal(parityResults.length, 2)
  assert.ok(parityResults.every(row => row.cases === 132 && row.mismatches.length === 0))
  assert.ok(negative.length === 2 && negative.every(row => row.mismatches.length === 1))
  assert.ok(parityResults.some(row => row.liveGames > 0) && parityResults.some(row => row.games === 0))
  assert.equal((await load('final-1-sql.json')).code, 0)
  const installed = summarize([...(await load('installed-1-samples.json')), ...(await load('installed-quarter-samples.json'))])
  assert.equal(installed.length, 48)
  assert.ok(installed.every(row => row.n === 5))
  const installedMisses = installed.filter(row => row.cpus === 1 && row.milliseconds.p95 >= (row.state === 'fresh' ? 150 : 60))
  const quotas = [await load('installed-1-quota.json'), await load('installed-quarter-quota.json')]
  const result = { baseline: '628c7def', migrationSha256: createHash('sha256').update(await readFile(candidateFile)).digest('hex'), measurements, installed, quotas, comparisons, nested,
    parity: parityResults.map(({ rows: _rows, ...row }) => row), negative: negative.map(({ rows: _rows, ...row }) => row), misses, installedMisses }
  await writeFile('tests/db/slow-screens-results.json', `${JSON.stringify(result, null, 2)}\n`)
  const lines = ['# Slow screen measurements', '', 'Each cell gives p50 / p95 in milliseconds. Five pairs alternate order.', '', '| CPU | Manager | Function | Before fresh | After fresh | Before warm | After warm | Before / after warm buffers |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |']
  const cell = row => `${row.milliseconds.p50.toFixed(2)} / ${row.milliseconds.p95.toFixed(2)}`
  for (const cpu of [1, 0.25]) for (const member of [1, 2, 3]) for (const name of names) {
    const find = (version, state) => measurements.find(row => row.cpus === cpu && row.member === member && row.name === name && row.variant === '{}' && row.version === version && row.state === state)
    lines.push(`| ${cpu} | ${member} | ${name} | ${cell(find('baseline', 'fresh'))} | ${cell(find('candidate', 'fresh'))} | ${cell(find('baseline', 'warm'))} | ${cell(find('candidate', 'warm'))} | ${find('baseline', 'warm').buffers.p95} / ${find('candidate', 'warm').buffers.p95} |`)
  }
  lines.push('', 'The JSON results include every variant and nested statement, with separate planning and execution times.', '')
  await writeFile('tests/db/slow-screens-tables.md', lines.join('\n'))
  console.log(JSON.stringify({ groups: measurements.length, samples: measurements.reduce((sum, row) => sum + row.n, 0), nested: nested.length, misses, installedMisses, parity: 264 }))
  assert.deepEqual(misses, [], 'A screen variant misses its one-CPU target')
  assert.deepEqual(installedMisses, [], 'An installed screen misses its one-CPU target')
}

if (process.argv.includes('--parity')) {
  assert.ok(candidate)
  await parity(fixture, versions)
} else if (process.argv.includes('--capture')) {
  const before = await quota()
  const samples = []
  for (let round = 0; round < Number(option('rounds') ?? 5); round++) {
    for (const row of selected) for (const version of round % 2 ? Object.keys(versions).reverse() : Object.keys(versions)) {
      const result = await measure(row, 'postgres', false, versions[version])
      for (const state of ['fresh', 'warm']) samples.push({ name: row.name, variant: row.variant, member: fixture.members.findIndex(member => member.id === row.member) + 1, round, version, cpus, state, ...result[state] })
      await save(`${label}-samples.json`, samples)
      console.log(`${round + 1} ${version} ${row.name} ${row.variant}: fresh ${result.fresh.milliseconds.toFixed(2)} / warm ${result.warm.milliseconds.toFixed(2)} ms; ${result.fresh.buffers} / ${result.warm.buffers} buffers`)
    }
  }
  const after = await quota()
  await save(`${label}-quota.json`, { cpus, before, after, delta: Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) })
} else if (process.argv.includes('--trace')) {
  for (const row of selected) for (const [version, definition] of Object.entries(versions)) {
    const result = await trace(row, definition)
    await save(`${label}-${version}-${row.name}-${selected.indexOf(row)}-trace.json`, result)
    for (const value of result.values.filter(value => value.phase)) console.log(JSON.stringify({ name: row.name, version, phase: value.phase, top: value.statements.filter(s => !s.toplevel).sort((a, b) => b.total_plan_time - a.total_plan_time).slice(0, 5).map(s => ({ query: s.query.slice(0, 150), plans: s.plans, calls: s.calls, planning: s.total_plan_time, execution: s.total_exec_time, buffers: s.buffers })) }))
  }
} else if (process.argv.includes('--sql')) {
  const definition = process.argv.includes('--baseline') ? baseline : candidate
  const result = await run(`BEGIN;${definition}\n${await readFile('tests/db/slow-screens.sql', 'utf8')}\nROLLBACK;`, 'postgres', { allowFailure: true })
  await save(`${label}-sql.json`, result)
  if (process.argv.includes('--negative-control')) assert.ok(result.code !== 0 && result.stderr.includes('Slow screen guard fails'), result.stderr)
  else assert.equal(result.code, 0, result.stderr)
  console.log(result.stdout || result.stderr)
} else if (process.argv.includes('--summary')) {
  const samples = await load(`${label}-samples.json`)
  const summary = summarize(samples)
  await save(`${label}-summary.json`, summary)
  console.log(JSON.stringify({ evidence, summary }))
} else if (process.argv.includes('--report')) await report()
else throw new Error('Choose --capture, --trace, --parity, --sql, --summary, or --report')
