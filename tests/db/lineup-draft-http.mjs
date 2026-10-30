import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const lane=path.join(homedir(),'pancake-t_4ba51e0d/lanes/fable-a3')
assert.equal(process.cwd(),path.join(lane,'repo'))
process.env.DOCKER_HOST=`unix://${homedir()}/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock`
const run=(name,args,input)=>execFileSync(name,args,{ input,encoding:'utf8',maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe'],timeout:60000 })
const database='postgresql://supabase_admin:postgres@127.0.0.1:64522/postgres'
const sql=source=>run('psql',[database,'-XqAt','-v','ON_ERROR_STOP=1'],source)
const resourceCheck=()=>{
  process.env.DOCKER_HOST=`unix://${homedir()}/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock`
  const value=JSON.parse(run('docker',['inspect','--format','{{json .HostConfig}}','supabase_db_pt4bafablea3']))
  assert.equal(value.NanoCpus,2_000_000_000)
  assert.equal(value.Memory,1_073_741_824)
}
resourceCheck()
const quote=value=>"'"+String(value).replaceAll("'","''")+"'"
const decode=source=>JSON.parse(source.trim().split('\n').filter(line=>line.startsWith('{')).at(-1))
const status=JSON.parse(run('supabase',['status','-o','json']))
assert.equal(status.API_URL,'http://127.0.0.1:64521')
assert.equal(new URL(status.DB_URL).port,'64522')
assert.ok(status.JWT_SECRET && status.SERVICE_ROLE_KEY)
const anchor=new Date().toISOString()
const edgeFiles=process.argv.slice(3)
assert.ok(edgeFiles.every(file=>/^supabase\/functions\/(lineup-optimizer|sync-draft-order|close-expired-nominations)\/.*\.ts$/.test(file)))
const edgeDefinitions=Object.fromEntries(edgeFiles.map(file=>[file,{before:run('git',['show',`952580ce:${file}`]),after:readFileSync(file,'utf8')}]))
const helper=process.argv[2]??'supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql'
const namespace=path.basename(path.dirname(helper))
const functionName=path.basename(helper,'.sql')
const definitions={ before:run('git',['show',`952580ce:${helper}`]),after:readFileSync(helper,'utf8') }
const builtinDefinitions=sql(`SELECT jsonb_build_object('now',pg_get_functiondef('pg_catalog.now()'::regprocedure),'clock',pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure),'uuid',pg_get_functiondef('pg_catalog.gen_random_uuid()'::regprocedure),'helper',(SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${quote(namespace)} AND p.proname=${quote(functionName)}),'pid',pg_get_functiondef('pg_catalog.pg_backend_pid()'::regprocedure));`)
const restore=Object.values(JSON.parse(builtinDefinitions)).map(source=>source.trimEnd()+';').join('\n')
const jwt=user=>{
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
  const issued=Math.floor(Date.parse(anchor)/1000)
  const value=encode({alg:'HS256',typ:'JWT'})+'.'+encode({aud:'authenticated',role:'authenticated',sub:user,iat:issued,exp:issued+3600,iss:'http://127.0.0.1:64521/auth/v1'})
  return value+'.'+createHmac('sha256',status.JWT_SECRET).update(value).digest('base64url')
}
const fixture=readFileSync('tests/db/lineup-draft-fixture.sql','utf8').replace('\\ir rules-support.sql',()=>readFileSync('tests/db/rules-support.sql','utf8'))
const directory=path.join(lane,'evidence')
mkdirSync(directory,{recursive:true})
const invocations=process.env.ACTION_HTTP_INVOCATIONS==='1'
const fingerprint=createHash('sha256').update(JSON.stringify({definitions,edgeDefinitions,fixture,runner:readFileSync('tests/db/lineup-draft-http-edge.mjs','utf8'),audit:readFileSync('tests/db/lineup-draft-http.sql','utf8'),counters:'per-query-reset-v1'})).digest('hex')
const observations=[]
const repeats=Number(process.env.ACTION_HTTP_REPEATS??1)
assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=5)
const pairLimit=process.env.ACTION_HTTP_PAIRS?Number(process.env.ACTION_HTTP_PAIRS):15
assert.ok(Number.isInteger(pairLimit)&&pairLimit>=5&&pairLimit<=15)
const benchmark=process.env.ACTION_HTTP_BENCH==='1'
const evidenceFile=path.join(directory,invocations?'http-invocations.json':benchmark?'http-benchmark.json':'http-quality.json')
if(process.env.ACTION_HTTP_RESUME==='1') {
  const previous=JSON.parse(readFileSync(evidenceFile,'utf8'))
  assert.equal(previous.fingerprint,fingerprint,'Resume requires identical action sources and fixtures')
  observations.push(...previous.observations)
}
const originalTrack=sql("SHOW pg_stat_statements.track;").trim()
const counters=()=>decode(sql("SELECT jsonb_build_object('queries',coalesce(jsonb_agg(jsonb_build_object('id',userid::text||':'||dbid::text||':'||queryid::text||':'||toplevel,'top',toplevel,'calls',calls,'ms',total_exec_time,'buffers',shared_blks_hit+shared_blks_read,'wal',wal_bytes)), '[]')) FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE '%pg_stat_clear_snapshot%';"))
const difference=(before,after)=>{
  const index=new Map(before.queries.map(row=>[row.id,row]))
  return after.queries.reduce((sum,row)=>{
    const old=index.get(row.id)??{calls:0,ms:0,buffers:0,wal:0}
    sum.statements+=row.calls-old.calls
    if(row.top) for(const field of ['ms','buffers','wal']) sum[field]+=row[field]-old[field]
    return sum
  },{statements:0,ms:0,buffers:0,wal:0})
}
const events=JSON.parse(sql("SELECT jsonb_agg(jsonb_build_object('name',evtname,'enabled',evtenabled)) FROM pg_event_trigger WHERE evtname IN ('pgrst_ddl_watch','pgrst_drop_watch');"))
const restoreEvents=events.map(row=>`ALTER EVENT TRIGGER ${row.name} ${row.enabled==='D'?'DISABLE':'ENABLE'};`).join('\n')
const recovery=path.join(lane,'restore-http.sql')
writeFileSync(recovery,restore+'\n'+restoreEvents)
let initialized=false
try {
  sql(events.map(row=>`ALTER EVENT TRIGGER ${row.name} DISABLE;`).join('\n'))
  if(benchmark) sql("ALTER SYSTEM SET pg_stat_statements.track='all'; SELECT pg_reload_conf();")
  const source=`BEGIN; ${readFileSync('tests/db/lineup-draft-http.sql','utf8')}
CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ${quote(anchor)}::timestamptz $$;
${fixture}
UPDATE auth.users SET instance_id='00000000-0000-0000-0000-000000000000',encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token='' WHERE id IN(SELECT unnest(user_ids) FROM action_fixture UNION ALL SELECT unnest(user_ids) FROM action_rookies UNION ALL SELECT unnest(user_ids) FROM action_auction_fixture);
SELECT jsonb_build_object('lineup',(SELECT to_jsonb(f) FROM action_fixture f),'rookie',(SELECT to_jsonb(f) FROM action_rookies f),'auction',(SELECT to_jsonb(f) FROM action_auction_fixture f),'snake',(SELECT id FROM action_snake),'auctionDraft',(SELECT id FROM action_auction),'tipoff',(SELECT to_jsonb(f) FROM action_tipoff f),'players',(SELECT jsonb_agg(to_jsonb(p) ORDER BY n) FROM action_players p),'cases',(SELECT jsonb_agg(to_jsonb(c)) FROM action_cases c),'board',(SELECT jsonb_agg(jsonb_build_object('display_name',display_name,'nba_draft_number',nba_draft_number) ORDER BY nba_draft_number) FROM public.players WHERE years_exp=0 AND nba_draft_number IS NOT NULL),'sequences',(SELECT jsonb_agg(to_jsonb(s)) FROM pg_sequences s WHERE schemaname IN ('public','private','auth','net')));
COMMIT;`
  const output=sql(source)
  initialized=true
  const manifest=decode(output)
  const selected=process.env.ACTION_HTTP_CASE
  const allNames=['slot-move-today','auto-set-button','optimizer-edge','pre-tipoff-edge','rookie-pick','mock-snake-pick','autopick','timer-expired','nominate','bid','close-expired','close-worker','sync-draft-order']
  for(let round=0;round<repeats;round++) for(let manager=1;manager<=3;manager++) for(const name of allNames.filter(value=>(!selected||new RegExp(selected).test(value))&&(!invocations||['optimizer-edge','pre-tipoff-edge','close-worker','sync-draft-order'].includes(value)))) {
    if(observations.filter(row=>row.name===name&&row.variant==='after').length>=pairLimit) continue
    if(observations.some(row=>row.name===name&&row.manager===manager&&row.round===round&&row.variant==='after')) continue
    const fixtureRow=['rookie-pick','mock-snake-pick','autopick','timer-expired'].includes(name)?manifest.rookie:['nominate','bid','close-expired','close-worker'].includes(name)?manifest.auction:manifest.lineup
    const user=fixtureRow.user_ids[manager-1],member=fixtureRow.member_ids[manager-1]
    const selectedCase=manifest.cases.find(row=>row.manager===manager && row.name===name)
    let prepare=selectedCase?.prepare??''
    const input={ name,anchor,jwt:jwt(user),body:{memberId:member} }
    if(name==='slot-move-today') input.args={p_member_id:member,p_league_id:manifest.lineup.league_id,p_league_season_id:manifest.lineup.season_id,p_game_date:anchor.slice(0,10),p_week_number:1,p_moves:[{player_id:manifest.players[(manager-1)*20].id,slot_type:'BE'},{player_id:manifest.players[(manager-1)*20+8].id,slot_type:'UTIL'}]}
    if(['auto-set-button','optimizer-edge','pre-tipoff-edge'].includes(name)) {
      const day=decode(sql("SELECT jsonb_build_object('day',(now() AT TIME ZONE 'America/New_York')::date); ")).day
      prepare+=`UPDATE public.lineup_optimizer_settings SET enabled=(member_id=${quote(member)}::uuid); DELETE FROM public.weekly_lineups WHERE member_id=${quote(member)} AND game_date=${quote(day)} AND player_id=${quote(manifest.players[(manager-1)*20].id)};`
      const dates=[0,1,8].map(offset=>new Date(Date.parse(day+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10))
      input.body={ leagueId:manifest.lineup.league_id,leagueSeasonId:manifest.lineup.season_id,memberId:member,dates }
      if(name==='optimizer-edge') {
        input.worker='lineup-optimizer';input.body={date:day}
        prepare+=`UPDATE public.nba_games SET season_year=9583,status='Scheduled',game_time=now()+interval '30 minutes',started_at=NULL WHERE game_date=${quote(day)};`
      }
      if(name==='pre-tipoff-edge') {
        input.worker='lineup-optimizer';input.body={mode:'pre_tipoff',tipoffAt:manifest.tipoff.at,token:manifest.tipoff.token}
        prepare+=`UPDATE public.lineup_tipoff_dispatches SET status='queued' WHERE tipoff_at=${quote(manifest.tipoff.at)};`
      }
    }
    if(['rookie-pick','mock-snake-pick','autopick','timer-expired'].includes(name)) {
      input.draft=manifest.snake
      input.action={'rookie-pick':'snake-pick','mock-snake-pick':'snake-pick',autopick:'auto-pick','timer-expired':'process-expired-pick'}[name]
      input.body={memberId:member,playerId:decode(sql('SELECT jsonb_build_object(\'id\',id) FROM public.players WHERE years_exp=0 AND nba_draft_number IS NOT NULL ORDER BY nba_draft_number,id LIMIT 1;')).id}
    }
    if(['nominate','bid','close-expired','close-worker'].includes(name)) {
      const row=manifest.cases.find(value=>value.manager===manager && value.name===(name==='close-worker'?'close-expired':name))
      prepare=row.prepare
      input.draft=manifest.auctionDraft
      input.action=name==='close-worker'?'close-expired':name
      input.body={memberId:member,playerId:decode(sql('SELECT jsonb_build_object(\'id\',id) FROM public.players WHERE years_exp=0 AND nba_draft_number IS NOT NULL ORDER BY nba_draft_number,id LIMIT 1;')).id,amount:1}
      if(name==='bid') input.body.nominationId=row.command.match(/place_auction_bid_atomic\('[^']+','[^']+','([^']+)'/)[1]
      if(name==='close-worker') {input.worker='close-expired-nominations';input.body={}}
    }
    if(name==='sync-draft-order') {input.worker='sync-draft-order';input.body={seasonYear:new Date(anchor).getUTCFullYear()};input.board=manifest.board}
    if(invocations) {
      input.invocationKey='99999999-9999-4999-8999-'+String(allNames.indexOf(name)*10+manager).padStart(12,'0')
      const kind=name==='pre-tipoff-edge'?'pre-tipoff':input.worker
      prepare+=`INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,invocation_key,payload) VALUES(${quote(kind)},${quote('a3:'+input.invocationKey)},'running',1,${quote(input.invocationKey)},now()+interval '5 minutes',${quote(input.invocationKey)},jsonb_build_object('lane',${quote(input.invocationKey)})); INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token) SELECT ${quote(input.worker)},${quote(input.invocationKey)},id,lease_token FROM private.work_items WHERE invocation_key=${quote(input.invocationKey)};`
    }
    const pair=[]
    for(const variant of ['before','after']) for(let attempt=0;attempt<3;attempt++) {
      assert.equal(sql(`SELECT count(*) FROM auth.users WHERE id=${quote(user)};`).trim(),'1','HTTP actor must exist in this private database')
      const mark=Number(sql('SELECT coalesce(max(n),0) FROM lineup_draft_http_lab.audit;').trim())
      try {
        const sequences=(manifest.sequences??[]).filter(row=>row.last_value!==null).map(row=>`SELECT setval(${quote(row.schemaname+'.'+row.sequencename)}::regclass,${row.last_value},true);`).join('\n')
        for(const [file,source] of Object.entries(edgeDefinitions)) writeFileSync(file,source[variant])
        sql(`${definitions[variant]} SELECT setval('lineup_draft_http_lab.ids',100000,false); ${sequences} ${prepare}`)
        if(invocations) input.workItemId=Number(sql(`SELECT id FROM private.work_items WHERE invocation_key=${quote(input.invocationKey)};`).trim())
        const actionMark=Number(sql('SELECT coalesce(max(n),0) FROM lineup_draft_http_lab.audit;').trim())
        const replaySequences=sql("SELECT string_agg(format('SELECT setval(%L::regclass,%s,true);',schemaname||'.'||sequencename,last_value),E'\n') FROM pg_sequences WHERE schemaname IN ('public','private','auth','net','lineup_draft_http_lab') AND sequencename<>'audit_n_seq' AND last_value IS NOT NULL;")
        const replayIds=decode(sql("SELECT jsonb_build_object('value',last_value,'called',is_called) FROM lineup_draft_http_lab.ids;"))
        const execute=()=>spawnSync('deno',['run','--cached-only','--no-check','--allow-env','--allow-read','--allow-net=127.0.0.1,localhost',invocations?'tests/db/lineup-draft-invocation-edge.mjs':'tests/db/lineup-draft-http-edge.mjs'],{encoding:'utf8',env:{...process.env,PANCAKE_SUPABASE_SECRET_KEY:status.SERVICE_ROLE_KEY,ACTION_INPUT:JSON.stringify(input)},maxBuffer:16*1024*1024,timeout:60000})
        const validate=result=>{
          if(result.error?.code==='ETIMEDOUT') throw new Error('Transient comparison timeout')
          if(/could not (start sync run record|record .*sync run)/.test(result.stderr)&&/TimeoutError|request_timeout/.test(result.stderr)) throw new Error('Transient bookkeeping timeout')
          assert.equal(result.status,0,result.stderr.slice(-1800))
          const response=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('RESULT ')).slice(7))
          if(input.worker&&!invocations) for(const method of ['POST','PATCH']) assert.ok(response.requests.some(request=>request.path==='/rest/v1/sync_runs'&&request.method===method&&request.status<300),`${name} missing ${method} bookkeeping`)
          if(invocations) for(const rpc of ['start_edge_invocation','renew_work_lease','finish_edge_invocation']) assert.ok(response.requests.some(request=>request.path==='/rest/v1/rpc/'+rpc&&request.status<300),`${name} missing ${rpc}`)
          return response
        }
        let result=execute()
        validate(result)
        let metrics
        if(benchmark) {
          assert.equal(result.status,0,result.stderr.slice(-1800))
          const recorded=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('RESULT ')).slice(7))
          const expectedState=decode(sql(`SELECT lineup_draft_http_lab.snapshot(${actionMark});`))
          const writes=decode(sql(`SELECT jsonb_build_object('tables',coalesce(jsonb_object_agg(table_name,counts),'{}')) FROM (SELECT table_name,jsonb_build_object('insert',count(*) FILTER(WHERE operation='INSERT'),'update',count(*) FILTER(WHERE operation='UPDATE'),'delete',count(*) FILTER(WHERE operation='DELETE'))counts FROM lineup_draft_http_lab.audit WHERE n>${actionMark} GROUP BY table_name)s;`)).tables
          sql(`SELECT lineup_draft_http_lab.undo(${actionMark},true); SELECT lineup_draft_http_lab.auditing(false); ${replaySequences} SELECT setval('lineup_draft_http_lab.ids',${replayIds.value},${replayIds.called});`)
          sql('SELECT extensions.pg_stat_statements_reset();')
          const before=counters()
          result=execute()
          validate(result)
          metrics={...difference(before,counters()),writes}
          assert.equal(result.status,0,result.stderr.slice(-1800))
          const measured=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('RESULT ')).slice(7))
          assert.equal(measured.body,recorded.body,'Measured replay response')
          assert.deepEqual(measured.requests.map(request=>[request.method,request.path]),recorded.requests.map(request=>[request.method,request.path]),'Measured replay request sequence')
          const measuredState=decode(sql(`SELECT lineup_draft_http_lab.snapshot(${actionMark});`))
          assert.ok(isDeepStrictEqual(measuredState,expectedState),`Measured replay rows differ: ${Object.keys(expectedState).filter(table=>!isDeepStrictEqual(measuredState[table],expectedState[table])).join(', ')}`)
          sql('SELECT lineup_draft_http_lab.auditing(true);')
        }
        writeFileSync(path.join(directory,`http-${name}-${manager}-${variant}.log`),result.stdout+result.stderr)
        assert.equal(result.status,0,result.stderr.slice(-1800))
        const response=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('RESULT ')).slice(7))
        if(['optimizer-edge','pre-tipoff-edge'].includes(name)) assert.ok(JSON.parse(response.body).optimized>0,`${name} must optimize a team`)
        if(['auto-set-button','optimizer-edge','pre-tipoff-edge','close-worker'].includes(name)) assert.equal(JSON.parse(response.body).failed,0,`${name} must finish its work`)
        if(name==='auto-set-button') assert.equal(JSON.parse(response.body).optimized,3,'Manual auto-set must apply today and both future dates')
        const state=decode(sql(`SELECT lineup_draft_http_lab.snapshot(${mark});`))
        const hashes=Object.fromEntries(Object.entries(state).map(([table,rows])=>[table,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]))
        pair.push({name,manager,variant,round,response,hashes,metrics})
        break
      } catch(error) {
        if(attempt===2||(!String(error).includes('HTTP_FAILURE /auth/v1/user {\"code\":\"request_timeout\"')&&!String(error).includes('Transient bookkeeping timeout')&&!String(error).includes('Transient comparison timeout')&&!String(error).includes('\"code\":\"57014\"'))) throw error
        process.stdout.write(`RETRY transient timeout ${name}/${manager}/${variant}\n`)
      } finally { sql(`SELECT lineup_draft_http_lab.auditing(true); SELECT lineup_draft_http_lab.undo(${mark});`) }
    }
    assert.equal(pair[1].response.body,pair[0].response.body,`${name}/${manager} raw HTTP response`)
    assert.deepEqual(pair[1].hashes,pair[0].hashes,`${name}/${manager} full touched-table rows`)
    resourceCheck()
    observations.push(...pair)
    writeFileSync(evidenceFile,JSON.stringify({fingerprint,complete:false,comparisons:observations.length/2,observations},null,2))
    process.stdout.write(`PASS HTTP ${name}/${manager}\n`)
  }
  writeFileSync(evidenceFile,JSON.stringify({fingerprint,complete:true,comparisons:observations.length/2,observations},null,2))
} finally {
  let cleaned=!initialized
  try { if(initialized) sql('SELECT lineup_draft_http_lab.undo(0);'); cleaned=true }
  finally {
    for(const [file,source] of Object.entries(edgeDefinitions)) writeFileSync(file,source.after)
    sql(restore+(cleaned?'\nDROP SCHEMA IF EXISTS lineup_draft_http_lab CASCADE;':''))
    if(benchmark) sql(`ALTER SYSTEM SET pg_stat_statements.track=${quote(originalTrack)}; SELECT pg_reload_conf();`)
    sql(restoreEvents)
    if(cleaned) rmSync(recovery)
  }
}
