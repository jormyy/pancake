import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { command } from '../../scripts/perf-lab/process.mjs'
import { project } from '../../scripts/perf-lab/common.mjs'

process.env.SCREEN_COST_EVIDENCE = 'slow-screen-addendum-evidence'
const { cases, plans, literal, load, save, evidence } = await import('./screen-view-costs.mjs')
const { run, measure, jsonValues } = await import('./unpartition-player-stats.mjs')
assert.equal(project, 'pt4bafablel3d')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const names = ['view_roster', 'view_players', 'view_league', 'view_trades', 'view_player', 'view_trade_block', 'get_trade_revaluation_inputs']
const candidateFile = option('candidate') ?? 'supabase/migrations/20261214000501_slow_screen_addendum.sql'
const candidate = (await readFile(candidateFile, 'utf8').catch(error => {
  if (!option('candidate') && error.code === 'ENOENT') return ''
  throw error
})).replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '')
const files = [...new Set([...candidate.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(/g)].map(match => `${match[1]}/${match[2]}.sql`))]
const baseline = (await Promise.all(files.map(async file => (await command('git', ['show', `${option('base') ?? '75196628'}:supabase/sql/functions/by-name/${file}`], { allowFailure: true })).stdout))).join('\n')
const versions = process.argv.includes('--installed') ? { candidate: '' } : candidate ? { baseline, candidate } : { baseline: '' }
const cpus = Number(option('cpus') ?? 1)
assert.ok([1, 0.25].includes(cpus))
await command('docker', ['update', `--cpus=${cpus}`, '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
const limits = await command('docker', ['inspect', '--format', '{{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}}', `supabase_db_${project}`])
assert.equal(limits.stdout.trim(), `${cpus * 1e9} 1073741824`)
const label = option('label') ?? `addendum-${cpus}`

async function inventory() {
  await command('node', ['tests/db/screen-view-costs.mjs', '--inventory'])
  const fixture = await load('fixture.json')
  const result = await run(`SELECT jsonb_build_object('player',(SELECT player_id FROM public.player_game_stats GROUP BY player_id ORDER BY count(*) DESC,player_id LIMIT 1),
    'liveDate',(SELECT max(game_date) FROM public.player_game_stats),
    'trades',(SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT t.id,t.league_id,m.id AS member,m.user_id AS "user",t.status,
      (SELECT count(*) FROM public.trade_items WHERE trade_id=t.id) AS assets
      FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
      WHERE t.league_id=${literal(fixture.league)}::uuid AND EXISTS(SELECT 1 FROM public.trade_items WHERE trade_id=t.id)
      ORDER BY (t.status IN('pending','accepted')) DESC,(SELECT count(*) FROM public.trade_items WHERE trade_id=t.id) DESC,t.id LIMIT 3) t));`)
  Object.assign(fixture, JSON.parse(result.stdout))
  assert.ok(fixture.player && fixture.trades.length)
  fixture.dates[0] = fixture.liveDate
  await save('fixture.json', fixture)
  console.log(JSON.stringify({ managers: fixture.members.length, trades: fixture.trades.map(row => ({ status: row.status, assets: row.assets })) }))
}

function workload(fixture, variants = false) {
  const selected = cases(fixture, true).filter(row => names.includes(row.name) && (variants || row.variant === '{}')).map(row => ({ ...row, role: 'authenticated', setup: '' }))
  for (const member of fixture.members) {
    const add = (name, params) => selected.push({ name, variant: JSON.stringify(params), member: member.id, user: member.user_id, role: 'authenticated', setup: '',
      expression: `public.${name}(${literal(fixture.league)}::uuid,${literal(member.id)}::uuid,${literal(JSON.stringify(params))}::jsonb)` })
    for (const params of variants ? [{}, ...['overview', 'games', 'news', 'history'].map(section => ({ section })), { seasonYear: 2025 }, { section: 'games', seasonYear: 2025, gameLimit: 100 }] : [{}]) add('view_player', { playerId: fixture.player, ...params })
    add('view_trade_block', {})
  }
  for (const trade of fixture.trades) selected.push({ name: 'get_trade_revaluation_inputs', variant: `assets-${trade.assets}`, user: trade.user, member: trade.member, role: 'service_role',
    setup: `SET LOCAL statement_timeout='3s';${['pending', 'accepted'].includes(trade.status) ? '' : `SET LOCAL session_replication_role=replica;UPDATE public.trades SET status='pending' WHERE id=${literal(trade.id)}::uuid;SET LOCAL session_replication_role=origin;`}`,
    expression: `public.get_trade_revaluation_inputs(${literal(trade.user)}::uuid,${literal(trade.member)}::uuid,${literal(trade.id)}::uuid)` })
  if (process.argv.includes('--dense')) {
    const trade = fixture.trades[0]
    const setup = `SET LOCAL session_replication_role=replica;
INSERT INTO public.trades SELECT (jsonb_populate_record(NULL::public.trades,to_jsonb(t)||jsonb_build_object('id',md5('l3d-dense-'||n)::uuid,'status','pending','proposed_at',now()-n*interval '1 second'))).* FROM public.trades t CROSS JOIN generate_series(1,40) n WHERE t.id=${literal(trade.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_participants SELECT (jsonb_populate_record(NULL::public.trade_participants,to_jsonb(p)||jsonb_build_object('trade_id',md5('l3d-dense-'||n)::uuid,'proposed_at',now()-n*interval '1 second'))).* FROM public.trade_participants p CROSS JOIN generate_series(1,40) n WHERE p.trade_id=${literal(trade.id)}::uuid ON CONFLICT DO NOTHING;
INSERT INTO public.trade_items SELECT (jsonb_populate_record(NULL::public.trade_items,to_jsonb(i)||jsonb_build_object('id',md5('l3d-item-'||i.id||'-'||n)::uuid,'trade_id',md5('l3d-dense-'||n)::uuid))).* FROM public.trade_items i CROSS JOIN generate_series(1,40) n WHERE i.trade_id=${literal(trade.id)}::uuid ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role=origin;`
    selected.push({ name: 'view_trades', variant: '40-cards', user: trade.user, member: trade.member, role: 'authenticated', setup,
      expression: `public.view_trades(${literal(trade.league_id)}::uuid,${literal(trade.member)}::uuid,'{}'::jsonb)` })
  }
  return selected.filter(row => !option('function') || option('function').split(',').includes(row.name))
}

async function trace(row, definition) {
  const snapshot = phase => `RESET ROLE;SELECT jsonb_build_object('phase','${phase}','statements',COALESCE(jsonb_agg(to_jsonb(s)),'[]')) FROM (SELECT query,toplevel,plans,calls,total_plan_time,total_exec_time,shared_blks_hit+shared_blks_read AS buffers,rows FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%') s;`
  const prime = Array.from({ length: 5 }, () => `SELECT ${row.expression}\n\\g /dev/null\n`).join('')
  const result = await run(`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;${definition}${row.setup}
SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL pg_stat_statements.track='all';SET LOCAL pg_stat_statements.track_planning=on;
LOAD 'auto_explain';SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_level=notice;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.sample_rate=1;
SELECT extensions.pg_stat_statements_reset();SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE ${row.role};
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${snapshot('fresh')}
SET LOCAL auto_explain.log_min_duration=-1;SET LOCAL ROLE ${row.role};${prime}
RESET ROLE;SELECT extensions.pg_stat_statements_reset();SET LOCAL auto_explain.log_min_duration=0;SET LOCAL ROLE ${row.role};
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};${snapshot('warm')}ROLLBACK;`)
  return { values: jsonValues(result.stdout), nested: plans(result.stderr) }
}

async function parity(fixture) {
  const rows = workload(fixture, true)
  const results = []
  for (const date of fixture.dates) {
    const freeze = text => text.replaceAll('now()', "(current_setting('screen_cost.clock')::timestamptz)")
    const record = table => rows.map((row, index) => `${row.setup}SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL ROLE ${row.role};INSERT INTO ${table} VALUES(${index},(${row.expression})::text);RESET ROLE;`).join('\n')
    const result = await run(`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;SET LOCAL screen_cost.clock=${literal(`${date}T19:00:00Z`)};${baseline}
DO $freeze$ DECLARE definition text;BEGIN FOR definition IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','private','analytics') AND p.prokind='f' AND pg_get_functiondef(p.oid) LIKE '%now()%' LOOP EXECUTE replace(definition,'now()','(current_setting(''screen_cost.clock'')::timestamptz)');END LOOP;END $freeze$;
SET LOCAL session_replication_role=replica;UPDATE public.nba_games SET status='InProgress' WHERE game_date=${literal(fixture.liveDate)}::date;SET LOCAL session_replication_role=origin;
${rows.filter(row => row.role === 'service_role').map(row => row.setup).join('\n')}
CREATE TEMP TABLE expected(id integer PRIMARY KEY,value text);CREATE TEMP TABLE actual(LIKE expected INCLUDING ALL);GRANT ALL ON expected,actual TO authenticated,service_role;
${record('expected')}${freeze(candidate)}${record('actual')}
SELECT jsonb_build_object('cases',count(*),'mismatches',COALESCE(jsonb_agg(e.id) FILTER(WHERE e.value IS DISTINCT FROM a.value),'[]'),
'games',(SELECT count(*) FROM public.nba_games WHERE game_date=${literal(date)}::date)) FROM expected e JOIN actual a USING(id);
UPDATE actual SET value=value||'broken' WHERE id=0;SELECT jsonb_build_object('negative',count(*)) FROM expected e JOIN actual a USING(id) WHERE e.value IS DISTINCT FROM a.value;ROLLBACK;`)
    const [summary, negative] = jsonValues(result.stdout)
    assert.deepEqual(summary.mismatches, [])
    assert.equal(negative.negative, 1)
    results.push({ date, ...summary, negative: negative.negative })
    await save(`${label}-parity.json`, results)
    console.log(JSON.stringify(results.at(-1)))
  }
}

function summarize(samples) {
  return [...Map.groupBy(samples, row => `${row.name}/${row.variant}/${row.member}/${row.version}/${row.state}/${row.cpus}`).values()].map(rows => {
    const distribution = key => {
      const values = rows.map(row => row[key]).sort((a, b) => a - b)
      return { p50: values[Math.floor(rows.length / 2)], p95: values[Math.ceil(rows.length * .95) - 1], spread: values.at(-1) - values[0] }
    }
    return { name: rows[0].name, variant: rows[0].variant.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<fixture>'), member: rows[0].member, version: rows[0].version, state: rows[0].state, cpus: rows[0].cpus, n: rows.length,
      ...Object.fromEntries(['milliseconds', 'planning', 'execution', 'buffers'].map(key => [key, distribution(key)])) }
  })
}

if (process.argv.includes('--inventory')) await inventory()
else {
  const fixture = await load('fixture.json')
  const rows = workload(fixture, process.argv.includes('--variants') || process.argv.includes('--historical')).filter(row => !process.argv.includes('--historical') || row.name === 'view_player' && row.variant.includes('"seasonYear":2025') && !row.variant.includes('"section"'))
  if (process.argv.includes('--capture')) {
    const samples = []
    for (let round = 0; round < Number(option('rounds') ?? 5); round++) for (const row of rows) for (const version of round % 2 ? Object.keys(versions).reverse() : Object.keys(versions)) {
      const result = await measure(row, 'postgres', false, versions[version])
      for (const state of ['fresh', 'warm']) samples.push({ name: row.name, variant: row.variant, member: rows.indexOf(row), round, version, state, cpus, ...result[state] })
      await save(`${label}-samples.json`, samples)
      console.log(`${round + 1} ${version} ${row.name} ${rows.indexOf(row)}: fresh ${result.fresh.milliseconds.toFixed(2)} / warm ${result.warm.milliseconds.toFixed(2)} ms; ${result.fresh.buffers} / ${result.warm.buffers} buffers`)
    }
  } else if (process.argv.includes('--trace')) {
    for (const row of rows) for (const [version, definition] of Object.entries(versions)) {
      const result = await trace(row, definition)
      await save(`${label}-${version}-${row.name}-${rows.indexOf(row)}-trace.json`, result)
      for (const value of result.values.filter(value => value.phase)) console.log(JSON.stringify({ name: row.name, version, phase: value.phase, top: value.statements.filter(s => !s.toplevel && !/^EXPLAIN/.test(s.query)).sort((a, b) => b.total_plan_time + b.total_exec_time - a.total_plan_time - a.total_exec_time).slice(0, 4).map(s => ({ query: s.query.slice(0, 170), planning: s.total_plan_time, execution: s.total_exec_time, buffers: s.buffers })) }))
    }
  } else if (process.argv.includes('--parity')) await parity(fixture)
  else if (process.argv.includes('--sql')) {
    const support = await readFile('tests/db/rules-support.sql', 'utf8')
    const recipe = (await readFile('tests/db/slow-screen-addendum.sql', 'utf8')).replace(/^\\set ON_ERROR_STOP on\s*/, '').replace(/^BEGIN;\s*/, '').replace(/\s*ROLLBACK;\s*$/, '')
      .replace('\\ir rules-support.sql', () => support)
    const result = await run(`BEGIN;${candidate}\n${recipe}\nROLLBACK;`, 'postgres', { allowFailure: true })
    await save(`${label}-sql.json`, result)
    console.log(result.stdout + result.stderr)
    assert.equal(result.code, 0)
  }
  else if (process.argv.includes('--summary')) console.log(JSON.stringify(summarize(await load(`${label}-samples.json`))))
  else if (process.argv.includes('--report')) {
    const measurements = summarize([...(await load('final-1-samples.json')), ...(await load('final-quarter-samples.json'))])
    const misses = measurements.filter(row => row.version === 'candidate' && row.cpus === 1 && row.milliseconds.p95 >= (row.state === 'warm' ? 60 : row.name === 'get_trade_revaluation_inputs' ? 300 : 150))
    const nested = []
    for (const file of (await readdir(evidence)).filter(file => /^final-(1|quarter)-.*-trace.json$/.test(file)).sort()) {
      const data = await load(file)
      for (const value of data.values.filter(value => value.phase)) nested.push({ capture: file, state: value.phase, statements: value.statements.filter(s => !s.toplevel && !/^EXPLAIN/.test(s.query)).sort((a, b) => b.total_plan_time + b.total_exec_time - a.total_plan_time - a.total_exec_time).slice(0, 8).map(s => ({ query: s.query.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<fixture>'), plans: s.plans, calls: s.calls, planning: s.total_plan_time, execution: s.total_exec_time, buffers: s.buffers })) })
    }
    const parityResults = await load('final-1-parity.json')
    const installed = summarize([...(await load('installed-1-samples.json')), ...(await load('installed-quarter-samples.json'))])
    const installedMisses = installed.filter(row => row.cpus === 1 && row.milliseconds.p95 >= (row.state === 'warm' ? 60 : row.name === 'get_trade_revaluation_inputs' ? 300 : 150))
    assert.equal(measurements.length, workload(fixture, true).length * 8)
    assert.equal(nested.length, workload(fixture).length * 8)
    assert.equal(installed.length, workload(fixture).length * 4)
    assert.ok(measurements.every(row => row.n === 5))
    assert.ok(installed.every(row => row.n === 5))
    assert.ok(parityResults.length === 2 && parityResults.every(row => row.mismatches.length === 0 && row.negative === 1))
    const sql = await load('final-1-sql.json')
    assert.equal(sql.code, 0)
    const optional = name => load(name).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const release = summarize([...(await optional('release-1-samples.json')), ...(await optional('release-quarter-samples.json'))])
    const releaseParity = await optional('release-1-parity.json')
    assert.ok(release.every(row => row.n === 5))
    assert.ok(release.filter(row => row.version === 'candidate' && row.cpus === 1).every(row => row.milliseconds.p95 < (row.state === 'warm' ? 60 : row.name === 'get_trade_revaluation_inputs' ? 300 : 150)))
    assert.ok(releaseParity.every(row => row.mismatches.length === 0 && row.negative === 1))
    const historical = []
    for (const file of (await readdir(evidence)).filter(file => /^historical-.*-trace.json$/.test(file)).sort()) {
      const data = await load(file)
      for (const value of data.values.filter(value => value.phase)) historical.push({ capture: file, state: value.phase, statements: value.statements.filter(s => !s.toplevel && !/^EXPLAIN/.test(s.query)).sort((a, b) => b.total_plan_time + b.total_exec_time - a.total_plan_time - a.total_exec_time).slice(0, 8).map(s => ({ query: s.query.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<fixture>'), plans: s.plans, calls: s.calls, planning: s.total_plan_time, execution: s.total_exec_time, buffers: s.buffers })) })
    }
    await writeFile('tests/db/slow-screen-addendum-results.json', `${JSON.stringify({ baseline: option('base') ?? '75196628', releaseBaseline: '628c7def', migrationSha256: createHash('sha256').update(await readFile(candidateFile)).digest('hex'), measurements, installed, release, releaseParity, nested, historical, parity: parityResults, sql: { passed: true, checks: Number(sql.stdout.trim().split('\n').at(-1)) }, misses, installedMisses }, null, 2)}\n`)
    const table = ['# Extended slow screen measurements', '', 'Each time is the largest p95 across three managers and the tested variants.']
    for (const [title, data] of [['Addendum changes from 75196628', measurements], ['Combined changes from release 2.8, 628c7def', release]]) {
      if (!data.length) continue
      table.push('', `## ${title}`, '', '| CPU | Function | Before fresh ms | After fresh ms | Before warm ms | After warm ms | Before / after warm buffers |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |')
      for (const cpu of [1, .25]) for (const name of [...names, '40-card trades']) {
        const selected = data.filter(row => row.cpus === cpu && (name === '40-card trades' ? row.variant === '40-cards' : row.name === name && row.variant !== '40-cards'))
        const maximum = (version, state, key) => Math.max(...selected.filter(row => row.version === version && row.state === state).map(row => row[key].p95))
        table.push(`| ${cpu} | ${name} | ${maximum('baseline', 'fresh', 'milliseconds').toFixed(2)} | ${maximum('candidate', 'fresh', 'milliseconds').toFixed(2)} | ${maximum('baseline', 'warm', 'milliseconds').toFixed(2)} | ${maximum('candidate', 'warm', 'milliseconds').toFixed(2)} | ${maximum('baseline', 'warm', 'buffers')} / ${maximum('candidate', 'warm', 'buffers')} |`)
      }
    }
    await writeFile('tests/db/slow-screen-addendum-tables.md', `${table.join('\n')}\n`)
    console.log(JSON.stringify({ samples: measurements.reduce((sum, row) => sum + row.n, 0), installedSamples: installed.reduce((sum, row) => sum + row.n, 0), captures: nested.length, parity: parityResults.reduce((sum, row) => sum + row.cases, 0), misses, installedMisses }))
    assert.deepEqual(misses, [])
    assert.deepEqual(installedMisses, [])
  } else throw new Error('Choose --inventory, --capture, --trace, --parity, --summary, or --report')
}
