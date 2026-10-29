import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

await requireMini()
assert.equal(project,'pt4bafablel3')
const directory=`${labRoot}/unpartition-migration`
await mkdir(directory,{recursive:true})
const option=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)
const sql=(input,database='l3_partitioned',options={})=>{
  assert.ok(['postgres','template1','l3_partitioned','l3_regular'].includes(database))
  return command('docker',['exec','-i',`supabase_db_${project}`,'psql','-XqAt','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1'],{input,timeout:360000,...options})
}
const save=(name,value)=>writeFile(`${directory}/${name}`,`${JSON.stringify(value,null,2)}\n`)

function instrument(source) {
  let text=source.replace('  started timestamptz:=clock_timestamp();','  started timestamptz:=clock_timestamp();\n  checkpoint timestamptz:=clock_timestamp();\n  item_started timestamptz;')
  const checkpoint=(name,detail="'{}'::jsonb")=>`\n  RAISE NOTICE 'stats_phase %',jsonb_build_object('phase','${name}','ms',extract(epoch FROM clock_timestamp()-checkpoint)*1000,'elapsedMs',extract(epoch FROM clock_timestamp()-started)*1000,'detail',${detail});\n  checkpoint:=clock_timestamp();\n`
  for(const [anchor,name,detail] of [
    ['  CREATE TABLE public.player_game_stats_rebuild','catalog',"jsonb_build_object('functions',jsonb_array_length(definitions),'typedFunctions',(SELECT count(*) FROM jsonb_array_elements(definitions) f WHERE (f->>'typed')::boolean),'views',jsonb_array_length(views),'indexes',jsonb_array_length(indexes),'outgoingFks',jsonb_array_length(constraints),'incomingFks',jsonb_array_length(incoming),'triggers',jsonb_array_length(triggers))"],
    ['  LOCK TABLE public.player_game_stats IN SHARE MODE;','prepare'],
    ['  SELECT count(*) INTO expected FROM public.player_game_stats;','lock_acquired'],
    ["  EXECUTE format('INSERT INTO public.player_game_stats_rebuild",'count'],
    ['  copied_at:=clock_timestamp();','copy'],
    ['  verified_at:=clock_timestamp();','verify'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) x(id oid,identity','swap'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(views)','functions'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) x(id oid,typed','views'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(publications)','drop_old_functions'],
    ['  DELETE FROM private.retention_status','publication'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(indexes)','retire_old_table'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(constraints)','indexes'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(incoming) x("table" text,name text,definition text,"comment" text) LOOP\n    EXECUTE format(\'ALTER TABLE %s ADD','outgoing_fks'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(policies)','incoming_fks'],
    ['  FOR item IN SELECT * FROM jsonb_to_recordset(triggers)','policies'],
    ["  EXECUTE format('ALTER TABLE public.player_game_stats OWNER",'triggers'],
    ['  IF clock_timestamp()-started>','grants'],
  ]) {
    assert.ok(text.includes(anchor),`Missing baseline checkpoint ${name}`)
    text=text.replace(anchor,()=>checkpoint(name,detail)+anchor)
  }
  text=text.replace('    EXECUTE item.definition;\n    IF item.typed THEN',"    item_started:=clock_timestamp();\n    EXECUTE item.definition;\n    RAISE NOTICE 'stats_item %',jsonb_build_object('phase','function','name',item.identity,'ms',extract(epoch FROM clock_timestamp()-item_started)*1000);\n    IF item.typed THEN")
  return text
}

async function measure() {
  const baseline=process.argv.includes('--baseline')
  if(process.argv.includes('--reset')) await sql('DROP DATABASE l3_regular;CREATE DATABASE l3_regular TEMPLATE l3_partitioned;','template1')
  let source=baseline?instrument((await command('git',['show','14db49e5:supabase/migrations/20261213000200_unpartition_player_game_stats.sql'])).stdout):await readFile('supabase/migrations/20261213000200_unpartition_player_game_stats.sql','utf8')
  const label=option('label')??(baseline?'baseline':'candidate')
  const started=performance.now()
  if(baseline) source=source.replace(/COMMIT;\s*$/,'ROLLBACK;')
  const result=await sql(source,option('database')??'l3_partitioned',{allowFailure:true})
  const phases=[...result.stderr.matchAll(/stats_phase (\{[^\n]+\})/g)].map(row=>JSON.parse(row[1]))
  const items=[...result.stderr.matchAll(/stats_item (\{[^\n]+\})/g)].map(row=>JSON.parse(row[1]))
  const value={label,code:result.code,wallMs:performance.now()-started,phases,items}
  await writeFile(`${directory}/${label}.log`,result.stdout+result.stderr)
  await save(`${label}.json`,value)
  console.log(JSON.stringify(value))
  assert.equal(result.code,0,result.stderr.slice(-2000))
}

async function dependencies() {
  const result=await sql(`SELECT jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'oid',p.oid,'xmin',p.xmin::text,'hash',md5(pg_get_functiondef(p.oid)),'language',l.lanname,'typed',p.prorettype IN(c.reltype,t.typarray) OR p.proargtypes::oid[]&&ARRAY[c.reltype,t.typarray] OR COALESCE(p.proallargtypes&&ARRAY[c.reltype,t.typarray],false),'dependencies',(SELECT coalesce(jsonb_agg(jsonb_build_object('class',d.refclassid::regclass::text,'object',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid))),'[]') FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND ((d.refclassid='pg_class'::regclass AND d.refobjid=c.oid) OR (d.refclassid='pg_type'::regclass AND d.refobjid IN(c.reltype,t.typarray))))) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang CROSS JOIN pg_class c JOIN pg_type t ON t.oid=c.reltype WHERE c.oid='public.player_game_stats'::regclass AND n.nspname IN('public','private','analytics') AND p.prokind='f' AND (p.prosrc ~ '\\mplayer_game_stats\\M' OR p.prorettype=c.reltype OR c.reltype=ANY(p.proargtypes::oid[]));`,option('database')??'l3_partitioned')
  const rows=JSON.parse(result.stdout)
  await save(`${option('label')??'before'}-dependencies.json`,rows)
  console.log(JSON.stringify({functions:rows.length,dependencies:rows.filter(row=>row.dependencies.length)}))
}

async function cachedPlans() {
  await sql('DROP DATABASE l3_regular;CREATE DATABASE l3_regular TEMPLATE l3_partitioned;','template1')
  const child=spawn('docker',['exec','-i',`supabase_db_${project}`,'psql','-XqAt','-U','supabase_admin','-d','l3_regular','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']})
  let output='',errors=''
  let ready
  const waiting=new Promise(resolve=>{ready=resolve})
  child.stdout.on('data',value=>{output+=value;if(output.includes('cache_ready')) ready()})
  child.stderr.on('data',value=>{errors+=value})
  const exited=new Promise(resolve=>child.on('exit',resolve))
  const query=`SELECT jsonb_build_object('count',pg_temp.stats_count(),'score',public.compute_fantasy_points((SELECT id FROM public.player_game_stats ORDER BY id LIMIT 1),(SELECT id FROM public.leagues ORDER BY id LIMIT 1)));EXECUTE stats_row;EXECUTE stats_count;`
  child.stdin.write(`CREATE FUNCTION pg_temp.stats_count() RETURNS bigint LANGUAGE plpgsql AS $fn$ BEGIN RETURN (SELECT count(*) FROM public.player_game_stats);END $fn$;
PREPARE stats_row AS SELECT private.player_game_appeared(s) FROM public.player_game_stats s ORDER BY id LIMIT 1;
PREPARE stats_count AS SELECT count(*) FROM public.player_game_stats;
${query}\n\\echo cache_ready\n`)
  await waiting
  try {
    await sql(await readFile('supabase/migrations/20261213000200_unpartition_player_game_stats.sql','utf8'),'l3_regular')
    child.stdin.end(query)
    const code=await exited
    await writeFile(`${directory}/cached-plans.log`,output+errors)
    assert.equal(code,0,errors)
    const values=output.trim().split('\n').filter(line=>line!=='cache_ready')
    assert.deepEqual(values.slice(0,3),values.slice(3))
    await save('cached-plans.json',{passed:true,values:values.slice(0,3)})
    console.log('Prepared SQL, cached PL/pgSQL, and the row-type helper survive the swap.')
  } finally { child.kill() }
}

async function heldStatement(statement,action) {
  const child=spawn('docker',['exec','-i',`supabase_db_${project}`,'psql','-XqAt','-U','supabase_admin','-d','l3_regular','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']})
  let output='',errors='',ready
  const waiting=new Promise(resolve=>{ready=resolve})
  child.stdout.on('data',value=>{output+=value;if(output.includes('lock_ready')) ready()})
  child.stderr.on('data',value=>{errors+=value})
  const exited=new Promise(resolve=>child.on('exit',resolve))
  child.stdin.write(`BEGIN;${statement}\n\\echo lock_ready\n`)
  await Promise.race([waiting,exited.then(()=>{throw new Error(errors)})])
  try { await action() }
  finally { child.stdin.end('COMMIT;');assert.equal(await exited,0,errors) }
}

async function resume() {
  await sql('DROP DATABASE l3_regular;CREATE DATABASE l3_regular TEMPLATE l3_partitioned;','template1')
  const source=await readFile('supabase/migrations/20261213000200_unpartition_player_game_stats.sql','utf8')
  const interrupted=source.replace('COMMIT;\nBEGIN;',()=>"COMMIT;\nDO $probe$ BEGIN RAISE EXCEPTION 'Post-copy failure probe';END $probe$;\nBEGIN;")
  const result=await sql(interrupted,'l3_regular',{allowFailure:true})
  assert.notEqual(result.code,0)
  assert.match(result.stderr,/Post-copy failure probe/)
  const state=JSON.parse((await sql(`SELECT jsonb_build_object('kind',(SELECT relkind FROM pg_class WHERE oid='public.player_game_stats'::regclass),'pending',(SELECT count(*) FROM pg_constraint WHERE conrelid='public.player_game_stats'::regclass AND contype='f' AND NOT convalidated),'state',to_regclass('private.player_stats_unpartition_state') IS NOT NULL);`,'l3_regular')).stdout)
  assert.deepEqual(state,{kind:'r',pending:2,state:true})
  const update="BEGIN;SET LOCAL lock_timeout='500ms';UPDATE public.player_game_stats SET points=points WHERE false;ROLLBACK;"
  await heldStatement('LOCK TABLE public.player_game_stats IN SHARE MODE;',async()=>{
    const result=await sql(update,'l3_regular',{allowFailure:true})
    assert.notEqual(result.code,0)
    assert.match(result.stderr,/lock timeout/)
  })
  await heldStatement('ALTER TABLE public.player_game_stats VALIDATE CONSTRAINT player_game_stats_game_id_fkey;',async()=>{
    assert.equal((await sql(update,'l3_regular')).code,0)
  })
  await sql(`BEGIN;ALTER TABLE public.player_game_stats DISABLE TRIGGER USER;DO $probe$ BEGIN BEGIN INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number) SELECT gen_random_uuid(),gen_random_uuid(),id,season_year,week_number FROM public.nba_games LIMIT 1;RAISE EXCEPTION 'Unvalidated FK permits a new invalid row';EXCEPTION WHEN foreign_key_violation THEN NULL;END;END $probe$;ROLLBACK;`,'l3_regular')
  await sql(source,'l3_regular')
  const completed=JSON.parse((await sql(`SELECT jsonb_build_object('pending',(SELECT count(*) FROM pg_constraint WHERE conrelid='public.player_game_stats'::regclass AND contype='f' AND NOT convalidated),'state',to_regclass('private.player_stats_unpartition_state') IS NOT NULL,'rows',(SELECT count(*) FROM public.player_game_stats));`,'l3_regular')).stdout)
  assert.equal(completed.pending,0)
  assert.equal(completed.state,false)
  assert.equal(completed.rows,245097)
  await save('resume.json',{passed:true,lockNegativeControl:true,writesDuringValidation:true,newForeignKeyEnforcement:true,state,completed})
  console.log('Validation permits writers, enforces new rows, and resumes after an interrupted migration.')
}

async function report() {
  const baseline=[],candidate=[]
  for(let round=1;round<=3;round++) {
    baseline.push(JSON.parse(await readFile(`${directory}/baseline-${round}.json`,'utf8')))
    candidate.push(JSON.parse(await readFile(`${directory}/candidate-${round}.json`,'utf8')))
  }
  const summarize=values=>{
    const ordered=values.sort((a,b)=>a-b)
    return {min:ordered[0],median:ordered[1],max:ordered.at(-1)}
  }
  const metric=(rows,phase)=>summarize(rows.map(row=>row.phases.find(value=>value.phase===phase)?.ms??0))
  const phaseNames=[...new Set([...baseline,...candidate].flatMap(row=>row.phases.map(value=>value.phase)))].filter(name=>name!=='lock_released')
  const phases=phaseNames.map(name=>({name,before:metric(baseline,name),after:metric(candidate,name)}))
  const before=JSON.parse(await readFile(`${directory}/before-dependencies.json`,'utf8'))
  const after=JSON.parse(await readFile(`${directory}/after-dependencies.json`,'utf8'))
  const oldFunctions=new Map(before.map(row=>[row.identity,row]))
  const unchanged=after.filter(row=>row.xmin===oldFunctions.get(row.identity)?.xmin&&row.hash===oldFunctions.get(row.identity)?.hash)
  const changed=after.filter(row=>!unchanged.includes(row)).map(row=>row.identity)
  assert.equal(unchanged.length,28)
  assert.deepEqual(changed.sort(),['private.guard_player_stats_identity()','private.player_game_appeared(player_game_stats)','view_game_day(uuid,uuid,jsonb)'].sort())
  const wall={before:summarize(baseline.map(row=>row.wallMs)),after:summarize(candidate.map(row=>row.wallMs))}
  assert.ok(wall.after.max<wall.before.min*.9,'The migration gain must exceed ten percent and the observed spread')
  const locks={before:summarize(baseline.map(row=>row.phases.filter(value=>['count','copy','verify','swap','functions','views','drop_old_functions','publication','retire_old_table','indexes','outgoing_fks','incoming_fks','policies','triggers','grants'].includes(value.phase)).reduce((sum,value)=>sum+value.ms,0))),after:metric(candidate,'lock_released')}
  const runnerLog=await readFile(`${directory}/migration-final.log`,'utf8')
  const runnerSeconds=Number(runnerLog.match(/([0-9.]+) total/)[1])
  const expectedProductionSeconds=Math.ceil(Math.max(wall.after.max,runnerSeconds*1000)*4/5000)*5
  assert.ok(expectedProductionSeconds<300)
  const value={cpu:.25,memoryBytes:1073741824,rows:245097,samples:3,wall,locks,phases,dependencyProof:{before:before.length,after:after.length,unchanged:unchanged.length,changed},safetyFactor:4,runnerSeconds,expectedProductionSeconds,baseline,candidate,cachedPlans:JSON.parse(await readFile(`${directory}/cached-plans.json`,'utf8')),resume:JSON.parse(await readFile(`${directory}/resume.json`,'utf8'))}
  await writeFile('tests/db/unpartition-migration-results.json',`${JSON.stringify(value,null,2)}\n`)
  const table=['# Migration phase timings','','PostgreSQL has 0.25 CPU and 1 GiB. Three interleaved runs use the restored 245,097 rows.','','Times are median seconds. The JSON includes every run and individual function, index, and FK timings.','','| Phase | Before | After |','| --- | ---: | ---: |']
  for(const row of phases) table.push(`| ${row.name} | ${(row.before.median/1000).toFixed(3)} | ${(row.after.median/1000).toFixed(3)} |`)
  table.push(`| Writer lock | ${(locks.before.median/1000).toFixed(3)} | ${(locks.after.median/1000).toFixed(3)} |`,`| Complete call | ${(wall.before.median/1000).toFixed(3)} | ${(wall.after.median/1000).toFixed(3)} |`)
  await writeFile('tests/db/unpartition-migration-tables.md',`${table.join('\n')}\n`)
  console.log(JSON.stringify({wall,locks,expectedProductionSeconds,unchanged:unchanged.length}))
}

if(process.argv.includes('--measure')) await measure()
else if(process.argv.includes('--cached-plans')) await cachedPlans()
else if(process.argv.includes('--resume')) await resume()
else if(process.argv.includes('--report')) await report()
else if(process.argv.includes('--dependencies')) await dependencies()
else throw new Error('Choose --measure or --dependencies')
