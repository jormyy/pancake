import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from '../../scripts/perf-lab/process.mjs'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'

process.env.SCREEN_COST_EVIDENCE ??= 'unpartition-evidence'
const { cases, plans, literal, load, save, evidence } = await import('./screen-view-costs.mjs')
await requireMini()
assert.ok(['pt4bafablel3','pt4bafablel3d','pt4bafablesr'].includes(project))
await mkdir(evidence,{recursive:true})
const option = name => process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)
const databaseNames = ['postgres','template1','l3_partitioned','l3_regular','l3_preservation']

async function run(input,database='postgres',options={}) {
  assert.ok(databaseNames.includes(database))
  return command('docker',['exec','-i',`supabase_db_${project}`,'psql','-XqAt','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1'],{input,timeout:240000,label:'private unpartition benchmark',...options})
}

function jsonValues(text) {
  const values=[]
  let start=-1,depth=0,quoted=false,escaped=false
  for(let i=0;i<text.length;i++) {
    const c=text[i]
    if(start<0) { if(c==='[' || c==='{') { start=i;depth=1 } continue }
    if(quoted) { if(escaped) escaped=false;else if(c==='\\') escaped=true;else if(c==='"') quoted=false }
    else if(c==='"') quoted=true
    else if(c==='[' || c==='{') depth++
    else if((c===']' || c==='}') && --depth===0) { values.push(JSON.parse(text.slice(start,i+1)));start=-1 }
  }
  return values
}

async function catalog(database,label) {
  const result=await run(await readFile('tests/db/unpartition-catalog.sql','utf8'),database)
  const value=JSON.parse(result.stdout.trim())
  await save(`${label}-catalog.json`,value)
  console.log(JSON.stringify({database,kind:value.relation.kind,partitions:value.relation.partitions,triggers:value.triggers.length,indexes:value.indexes.length,views:value.views.map(row=>row.name),rowTypeFunctions:value.rowTypeFunctions.map(row=>row.identity)}))
  return value
}

async function inventory() {
  await command('node',['tests/db/screen-view-costs.mjs','--inventory'],{env:{...process.env,SCREEN_COST_EVIDENCE:'unpartition-evidence'}})
  const fixture=await load('fixture.json')
  const result=await run(`SELECT jsonb_build_object(
    'refreshVersion',(SELECT version FROM private.screen_refresh_queue WHERE league_season_id=(SELECT id FROM public.league_seasons WHERE league_id=${literal(fixture.league)}::uuid AND is_current)),
    'season',(SELECT id FROM public.league_seasons WHERE league_id=${literal(fixture.league)}::uuid AND is_current),
    'playerIds',(SELECT jsonb_agg(DISTINCT player_id) FROM public.roster_players WHERE league_id=${literal(fixture.league)}::uuid),
    'player',(SELECT player_id FROM public.roster_players WHERE league_id=${literal(fixture.league)}::uuid ORDER BY id LIMIT 1),
    'trade',(SELECT to_jsonb(t) FROM (SELECT t.id,m.id AS member,m.user_id AS "user",t.status FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.league_id=${literal(fixture.league)}::uuid ORDER BY (t.status IN('pending','accepted')) DESC,t.proposed_at DESC LIMIT 1) t),
    'draft',(SELECT id FROM public.drafts WHERE league_id=${literal(fixture.league)}::uuid ORDER BY created_at DESC LIMIT 1),
    'game',(SELECT to_jsonb(g) FROM (SELECT g.id,g.nba_game_id,g.game_date,g.season_year FROM public.nba_games g JOIN public.player_game_stats s ON s.game_id=g.id WHERE g.season_year=public.current_season_year_et() GROUP BY g.id ORDER BY g.game_date DESC,count(*) DESC LIMIT 1) g));`)
  Object.assign(fixture,JSON.parse(result.stdout.trim()))
  assert.ok(fixture.game && fixture.trade && fixture.season)
  const payload=await run(`SELECT jsonb_agg(to_jsonb(s)-ARRAY['id','created_at','updated_at']||jsonb_build_object('points',COALESCE(s.points,0)+1) ORDER BY s.player_id) FROM public.player_game_stats s WHERE game_id=${literal(fixture.game.id)}::uuid;`)
  fixture.liveStats=JSON.parse(payload.stdout.trim())
  await save('fixture.json',fixture)
  await catalog('postgres','restored')
  console.log(JSON.stringify({members:fixture.members.length,liveStats:fixture.liveStats.length,tradeStatus:fixture.trade.status}))
}

function workload(f) {
  const user=f.members[0]
  const rows=cases(f).map(row=>({...row,role:row.name.startsWith('view_')?'authenticated':'service_role',setup:''}))
  const extra={playerId:f.player,playerIds:f.playerIds,date:f.game.game_date,tradeId:f.trade.id,draftId:f.draft}
  for(const name of ['view_player','view_trade_block','view_trade_details','view_trade_analysis','view_league_schedule','view_activity','view_picks','view_settings','view_claims','view_claim_editor','view_draft_rooms','view_draft_room','view_profile','view_context','view_game_day','view_transaction_state','view_league_settings','view_trade_preview']) {
    const member=name.startsWith('view_trade')?f.trade:{member:user.id,user:user.user_id}
    rows.push({name,variant:'default',role:'authenticated',user:member.user,member:member.member,setup:'',expression:`public.${name}(${literal(f.league)}::uuid,${literal(member.member)}::uuid,${literal(JSON.stringify(extra))}::jsonb)`})
  }
  rows.push({name:'view_team_timeline',role:'authenticated',user:user.user_id,member:user.id,setup:'',expression:`public.view_team_timeline(${literal(f.league)}::uuid,${literal(user.id)}::uuid)`})
  rows.push({name:'view_player_search',role:'authenticated',user:user.user_id,member:user.id,setup:'',expression:`(SELECT jsonb_agg(to_jsonb(player)) FROM public.view_player_search(p_league_id:=${literal(f.league)}::uuid,p_limit:=20) player)`})
  rows.push({name:'trivial_player_query',role:'service_role',user:user.user_id,setup:'',expression:`(SELECT count(*) FROM public.player_game_stats WHERE player_id=${literal(f.player)}::uuid AND game_date>current_date-30)`})
  const add=(name,expression,setup='')=>rows.push({name,role:'service_role',user:user.user_id,expression,setup})
  const token='10000000-0000-4000-8000-000000000001'
  add('refresh_views_complete',`public.view_refresh_work(${literal(f.league)}::uuid,NULL,jsonb_build_object('operation','complete','seasonId',${literal(f.season)},'claimToken',${literal(token)},'version',${f.refreshVersion}))`,
    `UPDATE private.screen_refresh_queue SET claim_token=${literal(token)}::uuid,claimed_version=version,claimed_at=now(),dirty=true,averages_initialized=false WHERE league_season_id=${literal(f.season)}::uuid;`)
  const clear=`DELETE FROM private.forecast_projection_inputs WHERE matchup_id=${literal(f.matchup)}::uuid;DELETE FROM private.forecast_player_history WHERE league_id=${literal(f.league)}::uuid;DELETE FROM private.forecast_season_points WHERE league_id=${literal(f.league)}::uuid;`
  add('forecast_prepare',`public.prepare_matchup_forecast_inputs(${literal(f.matchup)}::uuid)`,clear)
  add('forecast_compute',`public.get_matchup_forecast_context(${literal(f.matchup)}::uuid)`,clear)
  add('live_stats_save',`public.save_live_game_stats_atomic(${literal(f.game.id)}::uuid,${literal(f.game.nba_game_id)},${literal(JSON.stringify(f.liveStats))}::jsonb,10000)`,
    `SET LOCAL session_replication_role=replica;UPDATE public.nba_games SET status='InProgress',live_stats_elapsed_seconds=0 WHERE id=${literal(f.game.id)}::uuid;SET LOCAL session_replication_role=origin;SET LOCAL app.verified_stats_game=${literal(f.game.id)};`)
  add('trade_revaluation_inputs',`public.get_trade_revaluation_inputs(${literal(f.trade.user)}::uuid,${literal(f.trade.member)}::uuid,${literal(f.trade.id)}::uuid)`,
    `SET LOCAL session_replication_role=replica;UPDATE public.trades SET status='pending' WHERE id=${literal(f.trade.id)}::uuid;SET LOCAL session_replication_role=origin;`)
  return rows
}

function metrics(plan) {
  return {planning:plan['Planning Time'],execution:plan['Execution Time'],milliseconds:plan['Planning Time']+plan['Execution Time'],buffers:(plan.Plan['Shared Hit Blocks']??0)+(plan.Plan['Shared Read Blocks']??0)+(plan.Planning?.['Shared Hit Blocks']??0)+(plan.Planning?.['Shared Read Blocks']??0),rows:plan.Plan['Actual Rows']}
}

async function measure(row,database,nested=false,definition='') {
  const setup=`BEGIN;SET LOCAL statement_timeout='120s';SET LOCAL auto_explain.log_min_duration=-1;${definition}SET LOCAL request.jwt.claim.sub=${literal(row.user)};${row.setup}
LOAD 'auto_explain';SET LOCAL auto_explain.log_analyze=on;SET LOCAL auto_explain.log_buffers=on;SET LOCAL auto_explain.log_timing=off;SET LOCAL auto_explain.log_nested_statements=on;SET LOCAL auto_explain.log_format=json;SET LOCAL auto_explain.log_level=notice;SET LOCAL auto_explain.log_parameter_max_length=0;SET LOCAL auto_explain.sample_rate=1;
SET LOCAL auto_explain.log_min_duration=${nested?0:-1};SET LOCAL ROLE ${row.role};SAVEPOINT sample;`
  const prime=Array.from({length:5},()=>`SELECT ${row.expression}\n\\g /dev/null\nROLLBACK TO SAVEPOINT sample;`).join('\n')
  const result=await run(`${setup}EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};ROLLBACK TO SAVEPOINT sample;${prime}
EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT ${row.expression};ROLLBACK;`,database)
  const values=jsonValues(result.stdout).filter(value=>Array.isArray(value)&&value[0]?.Plan)
  assert.equal(values.length,2)
  return {fresh:{...metrics(values[0][0]),plan:values[0][0]},warm:{...metrics(values[1][0]),plan:values[1][0]},nested:nested?plans(result.stderr):[]}
}

async function capture() {
  const fixture=await load('fixture.json')
  const rows=workload(fixture).filter(row=>!option('function')||option('function').split(',').includes(row.name))
  const databases=(option('databases')??'l3_partitioned,l3_regular').split(',')
  const label=option('label')??'comparison'
  const samples=[]
  for(let round=0;round<5;round++) for(const row of rows) for(const database of round%2?[...databases].reverse():databases) {
    const result=await measure(row,database)
    for(const state of ['fresh','warm']) samples.push({name:row.name,database,round,state,...result[state]})
    await save(`${label}-samples.json`,samples)
    console.log(`${round+1} ${database} ${row.name}: fresh ${result.fresh.milliseconds.toFixed(2)} ms / ${result.fresh.buffers}; warm ${result.warm.milliseconds.toFixed(2)} ms / ${result.warm.buffers}`)
    if(round===0) await save(`${label}-${database}-${row.name}-nested.json`,await measure(row,database,true))
  }
}

async function contract() {
  const before=await catalog('l3_partitioned','before')
  const after=await catalog('l3_regular','after')
  for(const key of ['columns','triggers','policies','grants','incomingForeignKeys','views','rowTypeFunctions']) assert.deepEqual(after[key],before[key],key)
  assert.deepEqual(after.constraints.filter(row=>row.name!=='player_game_stats_id_unique'),before.constraints)
  const normalize=rows=>rows.filter(row=>row.name!=='player_game_stats_id_unique').map(row=>({...row,definition:row.definition.replace('ON ONLY ','ON ')}))
  assert.deepEqual(normalize(after.indexes),normalize(before.indexes))
  assert.equal(after.relation.kind,'r')
  assert.equal(after.relation.partitions,0)
  assert.deepEqual({...after.relation,kind:'p',partitions:before.relation.partitions},before.relation)
  assert.equal(after.retention.length,1)
  assert.equal(after.retention[0].relation_name,'public.player_game_stats')
  assert.equal(after.retention[0].worker,null)
  await save('contract.json',{passed:true,indexes:before.indexes.length,triggers:before.triggers.length,columns:before.columns.length,views:before.views.length,incomingForeignKeys:before.incomingForeignKeys.length})
  console.log('The table contract is preserved.')
}

async function snapshot(database,fixture,date) {
  const rows=workload(fixture)
  const screenVariants=cases({...fixture,dates:[date]},true).map(row=>({...row,role:row.name.startsWith('view_')?'authenticated':'service_role',setup:''}))
  rows.push(...screenVariants)
  for(const member of fixture.members.slice(1)) rows.push(...workload({...fixture,members:[member,...fixture.members.filter(row=>row.id!==member.id)]}).filter(row=>row.name.startsWith('view_')))
  const setup=`BEGIN;SET LOCAL statement_timeout='180s';SET LOCAL auto_explain.log_min_duration=-1;SET LOCAL screen_cost.clock=${literal(`${date}T19:00:00Z`)};
DO $clock$ DECLARE definition text;BEGIN FOR definition IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','private','analytics') AND p.prokind='f' AND pg_get_functiondef(p.oid) LIKE '%now()%' LOOP EXECUTE replace(definition,'now()','(current_setting(''screen_cost.clock'')::timestamptz)');END LOOP;END $clock$;
SET LOCAL session_replication_role=replica;UPDATE public.nba_games SET status='InProgress' WHERE game_date=(SELECT max(game_date) FROM public.player_game_stats);SET LOCAL session_replication_role=origin;
DO $prepare$ DECLARE day jsonb;BEGIN FOR day IN SELECT value FROM jsonb_array_elements(public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid)) LOOP PERFORM public.prepare_matchup_forecast_inputs(${literal(fixture.matchup)}::uuid,(day#>>'{}')::date);END LOOP;END $prepare$;
CREATE FUNCTION pg_temp.result(query text,setup text,role_name text,user_id text) RETURNS text LANGUAGE plpgsql AS $fn$ DECLARE result text;BEGIN BEGIN
  IF setup<>'' THEN EXECUTE setup;END IF;
  PERFORM set_config('request.jwt.claim.sub',user_id,true);EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
  EXECUTE 'SELECT to_jsonb('||query||')::text' INTO result;
  RAISE SQLSTATE 'P7777';EXCEPTION WHEN SQLSTATE 'P7777' THEN NULL;END;RETURN result;END $fn$;`
  const body=rows.map((row,index)=>`SELECT jsonb_build_object('id',${index},'value',pg_temp.result(${literal(row.expression)},${literal(row.setup)},${literal(row.role)},${literal(row.user)}));`).join('\n')
  const result=await run(`${setup}\n${body}\nROLLBACK;`,database)
  return {rows:rows.map(({name,variant,role})=>({name,variant,role})),values:jsonValues(result.stdout),database,date}
}

async function parity() {
  const fixture=await load('fixture.json')
  const dates=[(await run('SELECT max(game_date) FROM public.player_game_stats;','l3_partitioned')).stdout.trim(),fixture.dates[1]]
  const results=[]
  for(const date of dates) {
    const before=await snapshot('l3_partitioned',fixture,date)
    const after=await snapshot('l3_regular',fixture,date)
    await writeFile(`${evidence}/parity-${date}-before.json`,JSON.stringify(before))
    await writeFile(`${evidence}/parity-${date}-after.json`,JSON.stringify(after))
    const compare=values=>before.values.flatMap((row,index)=>row.value===values[index]?.value?[]:[{...before.rows[index],id:index}])
    const corrupted=structuredClone(after.values)
    corrupted[0].value+=' '
    assert.equal(compare(corrupted).length,1,'The byte parity negative control must fail')
    const differences=compare(after.values)
    results.push({date,cases:before.values.length,differences,negativeControl:true})
    await save('parity.json',results)
    assert.deepEqual(differences,[],'Screen or worker JSON differs')
    console.log(JSON.stringify(results.at(-1)))
  }
}

async function review() {
  const fixture=await load('fixture.json')
  const samples=[]
  for(const [name,file,before,after,targets] of [
    ['game-day','view_game_day','1f64045b','4d0eefd1',['view_game_day','view_home','view_lineup']],
    ['forecast-scope','get_prepared_matchup_forecast_context','1f64045b','4d0eefd1',['get_prepared_matchup_forecast_context']],
    ['upcoming-calendar','get_league_projection_rows','0cb294f9','d78a31c0',['view_players']],
    ['regular-calendar','get_league_projection_rows','d78a31c0','4d0eefd1',['view_players']],
  ].filter(row=>!option('change')||row[0]===option('change'))) {
    const definitions={}
    for(const [label,ref] of [['before',before],['after',after]]) definitions[label]=(await command('git',['show',`${ref}:supabase/sql/functions/by-name/public/${file}.sql`])).stdout
    for(let round=0;round<5;round++) for(const row of workload(fixture).filter(row=>targets.includes(row.name))) for(const version of round%2?['after','before']:['before','after']) {
      const result=await measure(row,'l3_regular',false,definitions[version])
      for(const state of ['fresh','warm']) samples.push({change:name,name:row.name,round,version,state,...result[state]})
      await save('review-samples.json',samples)
      console.log(`${name} ${round+1} ${version} ${row.name}: ${result.fresh.milliseconds.toFixed(2)} / ${result.warm.milliseconds.toFixed(2)} ms, ${result.fresh.buffers} / ${result.warm.buffers} buffers`)
    }
  }
}

function distribution(rows,key) {
  const values=rows.map(row=>row[key]).sort((a,b)=>a-b)
  assert.ok(values.length>=5)
  return {p50:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]}
}

async function report() {
  const samples=await load('final-samples.json')
  const functions=[]
  const nested=[]
  const usedIndexes=new Set()
  const visit=plan=>{
    if(plan['Index Name']) usedIndexes.add(plan['Index Name'])
    for(const child of plan.Plans??[]) visit(child)
  }
  for(const name of [...new Set(samples.map(row=>row.name))]) {
    const result={name}
    for(const database of ['l3_partitioned','l3_regular','l3_preservation']) {
      const version=database==='l3_regular'?'after':'before'
      result[version]={}
      for(const state of ['fresh','warm']) {
        const selected=samples.filter(row=>row.name===name&&row.database===database&&row.state===state)
        result[version][state]={n:selected.length,...Object.fromEntries(['planning','execution','milliseconds','buffers','rows'].map(key=>[key,distribution(selected,key)]))}
      }
      const capture=await load(`final-${database}-${name}-nested.json`)
      const grouped=new Map()
      for(const row of capture.nested) {
        visit(row.plan.Plan)
        if(/^EXPLAIN|^SELECT public\./.test(row.query)) continue
        const query=row.query.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'<fixture>')
        const key=createHash('sha256').update(query).digest('hex').slice(0,12)
        const item=grouped.get(key)??{key,query,calls:0,buffers:0,milliseconds:0,rows:0}
        item.calls++;item.buffers+=row.buffers;item.milliseconds+=row.milliseconds;item.rows+=row.rows
        grouped.set(key,item)
      }
      const top=[...grouped.values()]
      const selected=new Set([...top.sort((a,b)=>b.buffers-a.buffers).slice(0,5),...top.sort((a,b)=>b.milliseconds-a.milliseconds).slice(0,5)])
      nested.push({name,version,invocations:7,statements:[...selected].map(row=>({...row,buffers:row.buffers/7,milliseconds:row.milliseconds/7,rows:row.rows/7}))})
    }
    if(name.startsWith('view_')) {
      assert.ok(result.after.fresh.milliseconds.p95<250,`${name} fresh exceeds 250 ms`)
      assert.ok(result.after.warm.milliseconds.p95<150,`${name} warm exceeds 150 ms`)
    }
    if(name==='trivial_player_query') {
      assert.ok(result.before.fresh.planning.p50>2,'The baseline must fail the planning guard')
      assert.ok(result.after.fresh.planning.p95<2,'The candidate must pass the planning guard')
    }
    if(name==='get_league_version') assert.ok(result.after.warm.milliseconds.p95<2)
    if(name==='preview_trade_legality') assert.ok(result.after.warm.milliseconds.p95<100)
    functions.push(result)
  }
  const review=[...(await load('calendar-review-samples.json')).filter(row=>row.change!=='game-day'),...await load('review-samples.json')].filter((row,index,rows)=>rows.findIndex(other=>other.change===row.change&&other.name===row.name&&other.round===row.round&&other.version===row.version&&other.state===row.state)===index)
  const reviews=[]
  for(const change of [...new Set(review.map(row=>row.change))]) for(const name of [...new Set(review.filter(row=>row.change===change).map(row=>row.name))]) {
    const row={change,name}
    for(const version of ['before','after']) {
      const selected=review.filter(row=>row.change===change&&row.name===name&&row.version===version&&row.state==='warm')
      row[version]={milliseconds:distribution(selected,'milliseconds'),buffers:distribution(selected,'buffers')}
    }
    reviews.push(row)
  }
  const indexCatalog=JSON.parse((await run(`SELECT jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'constraint',EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid),'members',(SELECT jsonb_agg(t.relid::regclass::text) FROM pg_partition_tree(i.indexrelid) t))) FROM pg_index i WHERE i.indrelid='public.player_game_stats'::regclass;`,'l3_partitioned')).stdout)
  const indexes=indexCatalog.map(row=>({...row,observed:[row.name,...row.members].some(name=>usedIndexes.has(name.replace(/^public\./,''))),retained:true}))
  const migrationLog=await readFile(`${evidence}/migration-final.log`,'utf8')
  const migration=JSON.parse(migrationLog.match(/player_stats_rebuild (\{[^\n]+\})/)[1])
  assert.ok(migration.totalMs<60000&&migration.writerLockMs<60000)
  const result={functions,nested,reviews,indexes,migration,atomicCheck:await load('atomic-check.json'),usedIndexes:[...usedIndexes].sort(),contract:await load('contract.json'),parity:await load('parity.json')}
  await writeFile(evidencePath('unpartition-results.json'),`${JSON.stringify(result,null,2)}\n`)
  const table=['# Fresh connection and warm results','','Each cell gives p50 / p95. Time includes planning and execution. Buffers include planning.','','| Function | Before fresh ms | After fresh ms | Before warm ms | After warm ms | Before fresh buffers | After fresh buffers | After warm buffers | Rows |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
  const cell=value=>`${value.p50.toFixed(2)} / ${value.p95.toFixed(2)}`
  for(const row of functions) table.push(`| ${row.name} | ${cell(row.before.fresh.milliseconds)} | ${cell(row.after.fresh.milliseconds)} | ${cell(row.before.warm.milliseconds)} | ${cell(row.after.warm.milliseconds)} | ${cell(row.before.fresh.buffers)} | ${cell(row.after.fresh.buffers)} | ${cell(row.after.warm.buffers)} | ${cell(row.after.warm.rows)} |`)
  table.push('','## Largest nested statements','','Each trace contains one fresh invocation, five primes, and one warm invocation. Values are per invocation.','','| Function | Version | Statement | Buffers | Execution ms | Rows |','| --- | --- | --- | ---: | ---: | ---: |')
  for(const row of nested) for(const statement of row.statements) table.push(`| ${row.name} | ${row.version} | ${statement.key}: ${statement.query.replaceAll(/\s+/g,' ').replaceAll('|','\\|').slice(0,180)} | ${statement.buffers.toFixed(2)} | ${statement.milliseconds.toFixed(2)} | ${statement.rows.toFixed(2)} |`)
  table.push('','## Original index audit','','All nine original indexes remain. The native unique ID index is additional.','','| Index | Seen in a captured plan | Constraint | Retained |','| --- | --- | --- | --- |')
  for(const row of indexes) table.push(`| ${row.name} | ${row.observed} | ${row.constraint} | ${row.retained} |`)
  await writeFile(evidencePath('unpartition-tables.md'),`${table.join('\n')}\n`)
  console.log(JSON.stringify({functions:functions.length,latencyGuards:'pass',planningNegativeControl:'pass',parity:result.parity}))
}

if(fileURLToPath(import.meta.url)===path.resolve(process.argv[1]??'')) {
if(process.argv.includes('--inventory')) await inventory()
else if(process.argv.includes('--catalog')) await catalog(option('database')??'postgres',option('label')??'catalog')
else if(process.argv.includes('--capture')) await capture()
else if(process.argv.includes('--preservation')) {
  const migration=await readFile('supabase/migrations/20261213000200_unpartition_player_game_stats.sql','utf8')
  const [setup,check]=(await readFile('tests/db/unpartition-preservation.sql','utf8')).split(':migration_body')
  await run('DROP DATABASE IF EXISTS l3_preservation;CREATE DATABASE l3_preservation TEMPLATE l3_partitioned;','template1')
  try {
    const prepared=await run(setup+'\nCOMMIT;','l3_preservation')
    const applied=await run(migration,'l3_preservation')
    const verified=await run(check.replace(/ROLLBACK;\s*$/,''),'l3_preservation')
    await writeFile(`${evidence}/preservation.log`,prepared.stdout+applied.stdout+applied.stderr+verified.stdout)
    console.log('The preservation probe passes through both committed phases.')
  } finally { await run('DROP DATABASE l3_preservation;','template1') }
}
else if(process.argv.includes('--contract')) await contract()
else if(process.argv.includes('--parity')) await parity()
else if(process.argv.includes('--review')) await review()
else if(process.argv.includes('--report')) await report()
else if(process.argv.includes('--atomic-check')) {
  const before=await catalog('l3_partitioned','atomic-before')
  const migration=await readFile('supabase/migrations/20261213000200_unpartition_player_game_stats.sql','utf8')
  const result=await run(migration.replace("NOTIFY pgrst,'reload schema';","DO $failure$ BEGIN RAISE EXCEPTION 'Intentional atomic rollback probe'; END $failure$;"),'l3_partitioned',{allowFailure:true})
  assert.notEqual(result.code,0)
  assert.match(result.stderr,/Intentional atomic rollback probe/)
  const after=await catalog('l3_partitioned','atomic-after')
  assert.deepEqual(after,before,'A failed migration must restore every original object')
  await save('atomic-check.json',{passed:true,error:'Intentional atomic rollback probe',partitions:after.relation.partitions})
  console.log('The failed migration preserves all original objects.')
}
else if(process.argv.includes('--clone')) {
  await run("ALTER DATABASE postgres WITH ALLOW_CONNECTIONS=false;SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid();",'template1')
  await run('CREATE DATABASE l3_partitioned TEMPLATE postgres;CREATE DATABASE l3_regular TEMPLATE postgres;ALTER DATABASE postgres WITH ALLOW_CONNECTIONS=true;','template1').catch(async error=>{await run('ALTER DATABASE postgres WITH ALLOW_CONNECTIONS=true;','template1');throw error})
} else throw new Error('Choose --inventory, --catalog, --clone, or --capture')

}

export { run, workload, jsonValues, metrics, measure, catalog, evidence, labRoot }
