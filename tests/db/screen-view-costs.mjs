import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel3')
const evidenceName = process.env.SCREEN_COST_EVIDENCE ?? 'cost-evidence'
assert.match(evidenceName, /^[a-z0-9-]+$/)
const evidence = path.join(labRoot, evidenceName)
await mkdir(evidence, { recursive: true })
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const save = (name, value) => writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`)
const psql = input => command('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, timeout: 240000, label: 'private screen cost measurement' })
const load = async name => JSON.parse(await readFile(path.join(evidence, name), 'utf8'))

function cases(fixture, all = false) {
  const rows = []
  for (const member of fixture.members.slice(0, all ? 3 : 1)) {
    const add = (name, expression, variant = 'default') => rows.push({ name, variant, member: member.id, user: member.user_id, expression })
    const views = ['view_roster', 'view_home', 'view_trades', 'view_league', 'view_players', 'view_lineup', 'view_standings']
    for (const name of views) {
      const params = all ? [{}, ...fixture.dates.map(date => ({ date }))] : [{}]
      if (all && name === 'view_league') params.push(...['history', 'picks', 'draftBoard', 'settings', 'draft', 'mockRooms'].map(tab => ({ tab })))
      if (all && name === 'view_players') params.push(...['mine', 'rostered', 'available', 'free_agents', 'waivers'].map(availability => ({ availability })))
      if (all && name === 'view_trades') params.push({ tab: 'history' }, { status: 'pending' })
      for (const param of params) add(name, `public.${name}(${literal(fixture.league)}::uuid,${literal(member.id)}::uuid,${literal(JSON.stringify(param))}::jsonb)`, JSON.stringify(param))
    }
    add('get_league_version', `public.get_league_version(${literal(fixture.league)}::uuid,${literal(member.user_id)}::uuid,'0')`)
    if (all) add('get_league_version', `public.get_league_version(${literal(fixture.league)}::uuid,${literal(member.user_id)}::uuid,${literal(fixture.version)})`, 'current')
    add('preview_trade_legality', `public.preview_trade_legality(${literal(member.user_id)}::uuid,${literal(fixture.league)}::uuid,ARRAY[${literal(member.id)}::uuid,${literal(fixture.members.find(row => row.id !== member.id).id)}::uuid],'[]'::jsonb)`)
    add('get_prepared_matchup_forecast_context', `public.get_prepared_matchup_forecast_context(${literal(fixture.matchup)}::uuid)`)
  }
  return rows
}

function plans(stderr) {
  const rows = []
  const pattern = /NOTICE:  duration: ([\d.]+) ms  plan:\s*/g
  let match
  while ((match = pattern.exec(stderr))) {
    const start = pattern.lastIndex
    if (stderr[start] !== '{') continue
    let depth = 0, quoted = false, escaped = false, end = start
    for (; end < stderr.length; end++) {
      const char = stderr[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { end++; break }
    }
    const plan = JSON.parse(stderr.slice(start, end))
    rows.push({ milliseconds: Number(match[1]), query: plan['Query Text'], buffers: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0), rows: plan.Plan['Actual Rows'], plan })
    pattern.lastIndex = end
  }
  return rows
}

async function measure(row, nested, definition = '', warm = false) {
  const result = await psql(`BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL auto_explain.log_min_duration=-1;
${definition}
SET LOCAL request.jwt.claim.sub=${literal(row.user)};
LOAD 'auto_explain';
SET LOCAL auto_explain.log_analyze=on;
SET LOCAL auto_explain.log_buffers=on;
SET LOCAL auto_explain.log_timing=off;
SET LOCAL auto_explain.log_nested_statements=on;
SET LOCAL auto_explain.log_format=json;
SET LOCAL auto_explain.log_level=notice;
SET LOCAL auto_explain.log_parameter_max_length=0;
SET LOCAL auto_explain.sample_rate=1;
SET LOCAL ROLE ${row.name.startsWith('view_') ? 'authenticated' : 'service_role'};
${warm ? `DO $warm$ BEGIN PERFORM ${row.expression}; END $warm$;` : ''}
RESET ROLE;
SET LOCAL auto_explain.log_min_duration=${nested ? 0 : -1};
SET LOCAL ROLE ${row.name.startsWith('view_') ? 'authenticated' : 'service_role'};
EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};
ROLLBACK;`)
  const plan = JSON.parse(result.stdout.trim())[0]
  return { ...row, milliseconds: plan['Execution Time'], planning: plan['Planning Time'], buffers: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0), rows: plan.Plan['Actual Rows'], plan, nested: plans(result.stderr) }
}

async function restart() {
  await command('docker', ['restart', '--signal=SIGINT', '--timeout=5', `supabase_db_${project}`], { timeout: 60000 })
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await command('docker', ['exec', `supabase_db_${project}`, 'pg_isready', '-U', 'supabase_admin'], { allowFailure: true })
    if (result.code === 0) return
    await delay(250)
  }
  throw new Error('Private database does not become ready')
}

async function capture(fixture, label, definition = '', count = 5) {
  const samples = await load(`${label}-samples.json`).catch(() => [])
  for (let round = 0; round < count; round++) {
    for (const row of cases(fixture)) {
      if (samples.some(sample => sample.round === round && sample.name === row.name && sample.state === 'warm')) continue
      await restart()
      for (const state of ['cold', 'warm']) {
        const sample = { label, round, state, ...await measure(row, false, definition, state === 'warm') }
        samples.push(sample)
        await save(`${label}-samples.json`, samples)
        console.log(`${label} ${round + 1} ${state} ${row.name}: ${sample.milliseconds.toFixed(2)} ms, ${sample.buffers} buffers`)
      }
      if (round === 0) {
        await restart()
        for (const state of ['cold', 'warm']) await save(`${label}-${row.name}-${state}-nested.json`, await measure(row, true, definition, state === 'warm'))
      }
    }
  }
  return samples
}

async function definitions() {
  const candidate = await readFile(option('candidate') ?? 'supabase/migrations/20261213000100_screen_view_costs.sql', 'utf8')
  const names = [...candidate.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(/g)].map(match => `${match[1]}/${match[2]}.sql`)
  const baseline = []
  for (const name of [...new Set(names)]) {
    const result = await command('git', ['show', `${option('base') ?? '1f64045b'}:supabase/sql/functions/by-name/${name}`], { allowFailure: true })
    if (result.code === 0) baseline.push(result.stdout)
  }
  assert.ok(baseline.length)
  return { baseline: baseline.join('\n'), candidate }
}

async function parity(fixture, versions) {
  const extra = JSON.parse(await sql(`SELECT jsonb_build_object(
    'playerId',(SELECT player_id FROM public.roster_players WHERE league_id=${literal(fixture.league)}::uuid ORDER BY id LIMIT 1),
    'tradeId',(SELECT id FROM public.trades WHERE league_id=${literal(fixture.league)}::uuid ORDER BY proposed_at DESC LIMIT 1),
    'draftId',(SELECT id FROM public.drafts WHERE league_id=${literal(fixture.league)}::uuid ORDER BY created_at DESC LIMIT 1),
    'liveDate',(SELECT max(g.game_date) FROM public.nba_games g JOIN public.player_game_stats stat ON stat.game_id=g.id
      WHERE g.game_date<=current_date AND stat.player_id IN(SELECT player_id FROM public.roster_players WHERE league_id=${literal(fixture.league)}::uuid)));`))
  fixture.dates[0] = extra.liveDate
  assert.ok(fixture.dates.every(Boolean))
  const summaries = []
  const freeze = text => text.replaceAll('now()', "(current_setting('screen_cost.clock')::timestamptz)")
  for (const date of fixture.dates) {
    const rows = cases({ ...fixture,dates: [date] }, true)
    for (const member of fixture.members) {
      for (const name of ['view_player', 'view_trade_block', 'view_trade_details', 'view_trade_analysis', 'view_league_schedule', 'view_activity', 'view_picks', 'view_settings', 'view_claims', 'view_claim_editor', 'view_draft_rooms', 'view_draft_room', 'view_profile']) {
        rows.push({ name, user: member.user_id, member: member.id, variant: date,
          expression: `public.${name}(${literal(fixture.league)}::uuid,${literal(member.id)}::uuid,${literal(JSON.stringify({ ...extra, date }))}::jsonb)` })
      }
    }
    const record = (table, row, index) => `SET LOCAL ROLE ${row.name.startsWith('view_') ? 'authenticated' : 'service_role'};
SET LOCAL request.jwt.claim.sub=${literal(row.user)};
INSERT INTO ${table} VALUES (${index},(${row.expression})::text);
RESET ROLE;`
    const negative = process.argv.includes('--negative-control') ? "UPDATE expected SET value=value||'broken' WHERE id=0;" : ''
    const result = await psql(`BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL auto_explain.log_min_duration=-1;
SET LOCAL screen_cost.clock=${literal(`${date}T19:00:00Z`)};
${versions.baseline}
DO $freeze$
DECLARE definition text;
BEGIN
  FOR definition IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN('public','private','analytics') AND p.prokind='f'
      AND pg_get_functiondef(p.oid) LIKE '%now()%' LOOP
    EXECUTE replace(definition,'now()','(current_setting(''screen_cost.clock'')::timestamptz)');
  END LOOP;
END;
$freeze$;
SET LOCAL session_replication_role=replica;
UPDATE public.nba_games SET status='InProgress' WHERE game_date=${literal(extra.liveDate)}::date;
SET LOCAL session_replication_role=origin;
DO $prepare$
DECLARE day jsonb;
BEGIN
  FOR day IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid)) LOOP
    PERFORM public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid,(day#>>'{}')::date);
  END LOOP;
END;
$prepare$;
CREATE TEMP TABLE expected(id integer PRIMARY KEY,value text);
CREATE TEMP TABLE actual(LIKE expected INCLUDING ALL);
GRANT ALL ON expected,actual TO authenticated,service_role;
${rows.map((row,index) => record('expected',row,index)).join('\n')}
${freeze(versions.candidate)}
${rows.map((row,index) => record('actual',row,index)).join('\n')}
${negative}
SELECT jsonb_build_object('cases',count(*),'mismatches',COALESCE(jsonb_agg(e.id) FILTER(WHERE e.value IS DISTINCT FROM a.value),'[]'),
  'games',(SELECT count(*) FROM public.nba_games WHERE game_date=${literal(date)}::date),
  'liveGames',(SELECT count(*) FROM public.nba_games WHERE game_date=${literal(date)}::date AND status='InProgress'),
  'bytes',sum(octet_length(e.value))) FROM expected e JOIN actual a USING(id);
ROLLBACK;`)
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1))
    summaries.push({ ...summary,date,rows: rows.map(({ expression: _expression, user: _user, ...row }) => row) })
    await save(`parity${negative ? '-negative' : ''}.json`,summaries)
    assert.equal(summary.mismatches.length, negative ? 1 : 0, 'Screen JSON differs byte for byte')
    console.log(JSON.stringify({ ...summary,date }))
  }
}

async function interleave(fixture, versions) {
  const label = option('label') ?? 'round1'
  const samples = []
  const selected = cases(fixture).filter(row => !option('function') || option('function').split(',').includes(row.name))
  for (let round=0;round<5;round++) {
    for (const row of selected) {
      for (const version of round % 2 ? ['candidate','baseline'] : ['baseline','candidate']) {
        await restart()
        for (const state of ['cold','warm']) {
          const sample = { label, round, version, state, ...await measure(row,false,versions[version],state==='warm') }
          samples.push(sample)
          await save(`${label}-interleaved.json`,samples)
          console.log(`${label} ${round+1} ${version} ${state} ${row.name}: ${sample.milliseconds.toFixed(2)} ms, ${sample.buffers} buffers`)
        }
        if (round===0) {
          await restart()
          for (const state of ['cold','warm']) await save(`${label}-${version}-${row.name}-${state}-nested.json`,await measure(row,true,versions[version],state==='warm'))
        }
      }
    }
  }
}

async function controls() {
  const row = { name: 'timing_control', user: (await load('fixture.json')).members[0].user_id, expression: 'pg_sleep(0.025)' }
  const result = await measure(row,false)
  const accepts = sample => sample.milliseconds < 2 && sample.buffers < 3000
  assert.equal(accepts(result),false)
  assert.equal(accepts({ milliseconds: 1,buffers: 2 }),true)
  await save('timing-control.json',{ rejected: true,milliseconds: result.milliseconds,threshold: 2 })
  console.log('The timing guard rejects a delayed database read.')
}

async function warmSweep() {
  const fixture = await load('fixture.json')
  fixture.dates[0] = await sql('SELECT max(game_date) FROM public.player_game_stats;')
  const rows = cases(fixture,true)
  const samples = rows.map((row,index)=>`SET LOCAL ROLE ${row.name.startsWith('view_') ? 'authenticated' : 'service_role'};
SET LOCAL request.jwt.claim.sub=${literal(row.user)};
DO $sample$
DECLARE plan jsonb; iteration integer;
BEGIN
  FOR iteration IN 0..5 LOOP
    EXECUTE ${literal(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression}`)} INTO plan;
    IF iteration>0 THEN
      INSERT INTO sweep VALUES(${index},iteration,(plan->0->>'Execution Time')::numeric,
        COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0));
    END IF;
  END LOOP;
END;
$sample$;
RESET ROLE;`).join('\n')
  const result = await psql(`BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL auto_explain.log_min_duration=-1;
CREATE TEMP TABLE sweep(case_id integer,sample integer,milliseconds numeric,buffers bigint);
GRANT ALL ON sweep TO authenticated,service_role;
${samples}
SELECT jsonb_agg(to_jsonb(result)) FROM (
  SELECT case_id,count(*) AS samples,percentile_disc(0.5) WITHIN GROUP(ORDER BY milliseconds) AS p50,
    percentile_disc(0.95) WITHIN GROUP(ORDER BY milliseconds) AS p95,max(buffers) AS buffers
  FROM sweep GROUP BY case_id ORDER BY case_id
) result;
ROLLBACK;`)
  const values = JSON.parse(result.stdout.trim().split('\n').at(-1)).map(row=>({ ...row,name: rows[row.case_id].name,variant: rows[row.case_id].variant,member: fixture.members.findIndex(member=>member.id===rows[row.case_id].member)+1 }))
  await save('warm-sweep.json',values)
  const failures = values.filter(row=>row.buffers>=3000 || row.p95>=(row.name==='get_league_version' ? 2 : row.name==='preview_trade_legality' ? 100 : 150))
  console.log(JSON.stringify({ cases: values.length,failures }))
  assert.equal(failures.length,0,'A warm screen variant exceeds its cost budget')
}

function summarize(samples, minimum = 5) {
  const groups = new Map()
  for (const row of samples) {
    const key = `${row.name}/${row.state}/${row.version ?? row.label}`
    if (!groups.has(key)) groups.set(key,[])
    groups.get(key).push(row)
  }
  return [...groups.values()].map(rows => {
    const values = rows.map(row => row.milliseconds).sort((a,b)=>a-b)
    const buffers = rows.map(row => row.buffers)
    assert.ok(rows.length>=minimum,`${minimum} samples are required for ${rows[0].name}`)
    return { name: rows[0].name,state: rows[0].state,version: rows[0].version ?? rows[0].label,
      count: rows.length,p50: values[Math.ceil(values.length*0.5)-1],p95: values[Math.ceil(values.length*0.95)-1],
      meanBuffers: buffers.reduce((sum,value)=>sum+value,0)/rows.length,minBuffers: Math.min(...buffers),maxBuffers: Math.max(...buffers),
      rows: Math.max(...rows.map(row=>row.rows)) }
  }).sort((a,b)=>`${a.name}/${a.state}/${a.version}`.localeCompare(`${b.name}/${b.state}/${b.version}`))
}

async function report() {
  const files = await readdir(evidence)
  const rejections = await load('rejections.json').catch(()=>({}))
  const migration = await readFile('supabase/migrations/20261213000100_screen_view_costs.sql')
  const result = { baseline: '1f64045bdaf744a8da63c0687b3a357b4fb2c54c',migrationSha256: createHash('sha256').update(migration).digest('hex'),methodology: { cpus: 1,memoryBytes: 1073741824,cold: 'Postgres restart; host file cache retained',warm: 'Same connection after a priming call',timing: 'EXPLAIN ANALYZE BUFFERS with node timing disabled; nested logging disabled',samples: 5 },measurements: [],comparisons: [],nested: [] }
  for (const name of files.filter(name=>/^(baseline|final)-samples[.]json$/.test(name))) {
    result.measurements.push(...summarize(await load(name)))
  }
  for (const name of files.filter(name=>name.endsWith('-interleaved.json'))) {
    const label = name.replace('-interleaved.json','')
    result.comparisons.push({ name: label,rejected: rejections[label] ?? null,measurements: summarize(await load(name),rejections[label] ? 1 : 5) })
  }
  for (const name of files.filter(name=>name.endsWith('-nested.json'))) {
    const data = await load(name)
    const nested = data.nested.filter(row=>!row.query?.startsWith('EXPLAIN'))
    const compact = row => ({ query: row.query,milliseconds: row.milliseconds,buffers: row.buffers,rows: row.rows })
    result.nested.push({ capture: name,count: nested.length,
      byBuffers: [...nested].sort((a,b)=>b.buffers-a.buffers).slice(0,5).map(compact),
      byTime: [...nested].sort((a,b)=>b.milliseconds-a.milliseconds).slice(0,5).map(compact) })
  }
  const paritySummary = rows => rows.map(({ rows: _rows,...row })=>row)
  result.parity = paritySummary(await load('parity.json'))
  result.parityNegative = paritySummary(await load('parity-negative.json'))
  result.timingNegative = await load('timing-control.json')
  result.warmSweep = await load('warm-sweep.json').catch(()=>null)
  await writeFile('tests/db/screen-view-cost-results.json',`${JSON.stringify(result,null,2)}\n`)
  const lines = ['# Screen read measurements','',
    'Postgres uses one CPU and 1 GiB. Each cell uses five samples.',
    'Cold samples restart Postgres. The host file cache stays available.',
    'Nested logging stays disabled during latency measurements.',
    'Function rows count returned JSON responses. Nested rows count each captured statement result.','']
  for (const state of ['warm','cold']) {
    lines.push(`## ${state === 'warm' ? 'Warm' : 'Cold'} reads`,'',
      '| Function | Before p50 / p95 ms | After p50 / p95 ms | Before / after buffers | Rows |',
      '| --- | ---: | ---: | ---: | ---: |')
    for (const before of result.measurements.filter(row=>row.state===state && row.version==='baseline')) {
      const after = result.measurements.find(row=>row.state===state && row.version==='final' && row.name===before.name)
      lines.push(`| ${before.name} | ${before.p50.toFixed(2)} / ${before.p95.toFixed(2)} | ${after ? `${after.p50.toFixed(2)} / ${after.p95.toFixed(2)}` : 'Pending'} | ${before.maxBuffers} / ${after?.maxBuffers ?? 'Pending'} | ${before.rows} |`)
    }
    lines.push('')
  }
  lines.push('## Nested statements','','Parent totals include child work. Do not sum them.','')
  for (const label of ['baseline','final']) for (const state of ['warm','cold']) for (const metric of ['buffers','milliseconds']) {
    const rows = result.nested.filter(row=>row.capture.startsWith(`${label}-`) && row.capture.endsWith(`-${state}-nested.json`))
      .flatMap(row=>row[metric==='buffers' ? 'byBuffers' : 'byTime'].map(statement=>({ ...statement,function: row.capture.slice(label.length+1,-`-${state}-nested.json`.length) })))
      .sort((a,b)=>b[metric]-a[metric]).slice(0,5)
    if (!rows.length) continue
    lines.push(`### ${label} ${state}, ranked by ${metric}`,'','| Function | Statement prefix | Buffers | ms | Rows |','| --- | --- | ---: | ---: | ---: |')
    for (const row of rows) lines.push(`| ${row.function} | ${row.query.replaceAll(/\s+/g,' ').replaceAll('|','/').slice(0,110)} | ${row.buffers} | ${row.milliseconds.toFixed(2)} | ${row.rows} |`)
    lines.push('')
  }
  await writeFile('tests/db/screen-view-cost-tables.md',`${lines.join('\n')}\n`)
  console.log(JSON.stringify({ measurements: result.measurements.length,comparisons: result.comparisons.length,nestedCaptures: result.nested.length }))
}

async function verify() {
  const fixture = await load('fixture.json')
  const names = cases(fixture).map(row=>row.name).sort()
  for (const label of ['baseline','final']) {
    const rows = summarize(await load(`${label}-samples.json`))
    assert.deepEqual(rows.filter(row=>row.state==='warm').map(row=>row.name).sort(),names)
    assert.deepEqual(rows.filter(row=>row.state==='cold').map(row=>row.name).sort(),names)
    for (const row of rows) {
      assert.equal(row.count,5)
      const nested = await load(`${label}-${row.name}-${row.state}-nested.json`)
      assert.ok(nested.nested.length>=2)
      if (label==='final' && row.state==='warm') {
        assert.ok(row.maxBuffers<3000,`${row.name} exceeds the buffer limit`)
        assert.ok(row.p95<(row.name==='get_league_version' ? 2 : row.name==='preview_trade_legality' ? 100 : 150),`${row.name} exceeds the time limit`)
      }
    }
  }
  const parity = await load('parity.json')
  const negative = await load('parity-negative.json')
  assert.equal(parity.length,2)
  assert.ok(parity.some(row=>row.liveGames>0))
  assert.ok(parity.some(row=>row.games===0))
  assert.ok(parity.every(row=>row.cases>=132 && row.mismatches.length===0))
  assert.ok(negative.every(row=>row.mismatches.length===1))
  const sweep = await load('warm-sweep.json')
  assert.equal(sweep.length,114)
  assert.ok(sweep.every(row=>row.samples===5 && row.buffers<3000 && row.p95<(row.name==='get_league_version' ? 2 : row.name==='preview_trade_legality' ? 100 : 150)))
  assert.equal((await load('sql-guard-after.json')).code,0)
  assert.ok((await load('sql-guard-before.json')).stderr.includes('Screen cost guard fails'))
  assert.equal((await load('timing-control.json')).rejected,true)
  const result = { passed: true,functions: names.length,samples: 200,nestedCaptures: 40,parity: parity.reduce((sum,row)=>sum+row.cases,0),variants: sweep.length }
  await save('completion.json',result)
  console.log(JSON.stringify(result))
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
if (process.argv.includes('--setup')) {
  const manifest = JSON.parse(await readFile(path.join(labRoot, 'backup/manifest.json'), 'utf8'))
  for (const name of ['schema.sql', 'data.sql']) {
    assert.equal(createHash('sha256').update(await readFile(path.join(labRoot, 'backup', name))).digest('hex'), manifest[name])
  }
  await rm(path.join(evidence, 'stop'), { force: true })
  await rm(path.join(evidence, 'ready.json'), { force: true })
  await withDatabase(async () => {
    await command('docker', ['update', '--cpus=1', '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
    await sql("ALTER SYSTEM SET auto_explain.log_min_duration='-1'; SELECT pg_reload_conf();")
    const limits = await command('docker', ['inspect', '--format', '{{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}}', `supabase_db_${project}`])
    assert.equal(limits.stdout.trim(), '1000000000 1073741824')
    await writeFile(path.join(evidence, 'ready.json'), JSON.stringify({ limits: limits.stdout.trim(), ready: true }))
    console.log('The private database is ready with one CPU and 1 GiB.')
    while (true) {
      try { await access(path.join(evidence, 'stop')); break } catch {}
      await delay(500)
    }
  })
} else if (process.argv.includes('--inventory')) {
  const fixture = JSON.parse(await sql(`WITH chosen AS (
    SELECT l.id FROM public.leagues l JOIN public.league_members m ON m.league_id=l.id
    JOIN public.roster_players r ON r.member_id=m.id WHERE l.deleted_at IS NULL
    GROUP BY l.id ORDER BY count(*) DESC,l.id LIMIT 1
  ) SELECT jsonb_build_object('league',c.id,
    'members',(SELECT jsonb_agg(to_jsonb(m)) FROM (SELECT id,user_id FROM public.league_members WHERE league_id=c.id AND user_id IS NOT NULL ORDER BY id LIMIT 3) m),
    'matchup',(SELECT m.id FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id WHERE m.league_id=c.id AND NOT m.is_voided ORDER BY s.is_current DESC,m.week_number,m.id LIMIT 1),
    'version',(SELECT version::text FROM public.league_versions WHERE league_id=c.id),
    'dates',jsonb_build_array((SELECT game_date FROM public.nba_games WHERE status='InProgress' ORDER BY game_date DESC LIMIT 1),
      (SELECT d::date FROM generate_series(current_date-30,current_date,'1 day') d WHERE NOT EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=d::date) ORDER BY d DESC LIMIT 1))) FROM chosen c;`))
  assert.equal(fixture.members.length, 3)
  assert.ok(fixture.matchup)
  await save('fixture.json', fixture)
  const dates = JSON.parse(await sql(`SELECT public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid);`))
  for (const date of dates) await sql(`SELECT public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid,${literal(date)}::date);`)
  await sql('ANALYZE;')
  console.log(JSON.stringify({ members: fixture.members.length, dates: fixture.dates, preparedDays: dates.length }))
} else if (process.argv.includes('--capture')) {
  await capture(await load('fixture.json'), option('label') ?? 'baseline', '', Number(option('count') ?? 5))
} else if (process.argv.includes('--nested')) {
  const selected = cases(await load('fixture.json')).filter(row => !option('function') || row.name === option('function'))
  for (const row of selected) {
    await restart()
    for (const state of ['cold','warm']) await save(`${option('label') ?? 'baseline'}-${row.name}-${state}-nested.json`,await measure(row,true,'',state==='warm'))
  }
} else if (process.argv.includes('--probe')) {
  const selected = cases(await load('fixture.json')).filter(row => !option('function') || row.name === option('function'))
  for (const row of selected) {
    const definition = process.argv.includes('--candidate-probe') ? (await definitions()).candidate : ''
    const result = await measure(row, true, definition, process.argv.includes('--warm'))
    await save(`probe-${row.name}.json`, result)
    console.log(JSON.stringify({ name: row.name, ms: result.milliseconds, buffers: result.buffers, top: [...result.nested].sort((a,b) => b.buffers-a.buffers).slice(0,5).map(({ query, buffers, milliseconds }) => ({ query: query.slice(0,160), buffers, milliseconds })) }))
  }
} else if (process.argv.includes('--parity')) {
  await parity(await load('fixture.json'),await definitions())
} else if (process.argv.includes('--interleave')) {
  await interleave(await load('fixture.json'),await definitions())
} else if (process.argv.includes('--controls')) {
  await controls()
} else if (process.argv.includes('--warm-sweep')) {
  await warmSweep()
} else if (process.argv.includes('--sql-guard')) {
  const result = await command('docker',['exec','-i',`supabase_db_${project}`,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],
    { input: await readFile('tests/db/screen-view-costs.sql','utf8'),allowFailure: true,timeout: 240000 })
  const expectedFailure = process.argv.includes('--expect-guard-failure')
  assert.equal(expectedFailure ? result.stderr.includes('Screen cost guard fails') : result.code===0,true,result.stderr)
  await save(expectedFailure ? 'sql-guard-before.json' : 'sql-guard-after.json',result)
  console.log(expectedFailure ? 'The SQL cost guard rejects the baseline.' : result.stdout)
} else if (process.argv.includes('--report')) {
  await report()
} else if (process.argv.includes('--reject')) {
  const rejections = await load('rejections.json').catch(()=>({}))
  assert.ok(option('label') && option('reason'))
  rejections[option('label')] = option('reason')
  await save('rejections.json',rejections)
} else if (process.argv.includes('--verify')) {
  await verify()
} else {
  throw new Error('Choose --setup, --inventory, --capture, --probe, --parity, --interleave, or --controls.')
}

}

export { cases, plans, parity, literal, psql, load, save, evidence }
