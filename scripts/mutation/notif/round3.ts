import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const db = Deno.env.get('SUPABASE_DB_URL')!
const target = new URL(db)
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
if (!/^\d+$/.test(port) || !['127.0.0.1','localhost'].includes(target.hostname) || target.port !== port) throw new Error('Only configured loopback database allowed')
const evidence = Deno.env.get('NOTIF_EVIDENCE')!
if (!path.isAbsolute(evidence) || evidence.startsWith(Deno.cwd()+'/')) throw new Error('Evidence must be outside repository')
const sql = (source: string) => {
  const result = spawnSync('psql',[db,'-XqAtv','ON_ERROR_STOP=1'],{input:source,encoding:'utf8'})
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const oracle = (id: string,kind: string) => {
  const command = kind === 'edge'
    ? ['deno','test','--allow-env','supabase/functions/_shared/notificationDelivery.notif.test.ts','supabase/functions/process-trades/outbox.test.ts']
    : ['psql',db,'-XqAtv','ON_ERROR_STOP=1','-v','notif_case=all','-f',kind==='wake'?'tests/db/notif-wake.sql':kind==='web'?'tests/db/notif-web-ticket.sql':'tests/db/notif-round3.sql']
  const started=performance.now()
  const result=spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:60000})
  const log=path.join(evidence,`r3-mutation-${id}.log`)
  writeFileSync(log,result.stdout+result.stderr)
  const record={name:`r3-mutation-${id}`,command,exit:result.status??-1,seconds:(performance.now()-started)/1000,log}
  appendFileSync(path.join(evidence,'commands.jsonl'),JSON.stringify(record)+'\n')
  return record
}
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const resultsFile = path.join(evidence,'results.jsonl')
const priorResults = readFileSync(resultsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
const targets = [
  {
    "id": "N15",
    "file": "private/notif_lineup_candidates.sql",
    "symbol": "private.notif_lineup_candidates(timestamptz)",
    "original": "lower(COALESCE(p.injury_status,'')) IN ('out','inactive','suspended')",
    "mutated": "false",
    "operator": "remove injury-status inactive source",
    "kind": "sql"
  },
  {
    "id": "N16",
    "file": "private/notif_lineup_candidates.sql",
    "symbol": "private.notif_lineup_candidates(timestamptz)",
    "original": "interval '2 hours'",
    "mutated": "interval '3 hours'",
    "operator": "widen warning window by one hour",
    "kind": "sql"
  },
  {
    "id": "N17",
    "file": "private/notif_lineup_candidates.sql",
    "symbol": "private.notif_lineup_candidates(timestamptz)",
    "original": "&& public.lineup_slot_allowed_positions(slot.slot_type)",
    "mutated": "&& ARRAY['XX']",
    "operator": "replace slot eligibility with impossible position",
    "kind": "sql"
  },
  {
    "id": "N18",
    "file": "private/notif_lineup_candidates.sql",
    "symbol": "private.notif_lineup_candidates(timestamptz)",
    "original": "AND NOT r.is_on_ir AND NOT r.is_on_taxi",
    "mutated": "AND NOT r.is_on_taxi",
    "operator": "remove IR exclusion in both candidate branches",
    "kind": "sql"
  },
  {
    "id": "N19",
    "file": "private/notif_watch_drop_trigger.sql",
    "symbol": "private.notif_watch_drop_trigger()",
    "original": "AND w.member_id IS DISTINCT FROM NEW.dropped_by_member_id",
    "mutated": "",
    "operator": "remove dropper exclusion",
    "kind": "sql"
  },
  {
    "id": "N20",
    "file": "private/notif_watch_drop_trigger.sql",
    "symbol": "private.notif_watch_drop_trigger()",
    "original": "jsonb_build_object('playerId',NEW.player_id",
    "mutated": "jsonb_build_object('playerId',NULL",
    "operator": "erase watched drop player identity",
    "kind": "sql"
  },
  {
    "id": "N21",
    "file": "private/notif_announcement_trigger.sql",
    "symbol": "private.notif_announcement_trigger()",
    "original": "AND id<>NEW.author_member_id",
    "mutated": "",
    "operator": "include author among notification recipients",
    "kind": "sql"
  },
  {
    "id": "N22",
    "file": "public/notif_publish_announcement_atomic.sql",
    "symbol": "public.notif_publish_announcement_atomic(uuid,text,uuid)",
    "original": "VALUES(p_request_id,p_league_id,m,body)",
    "mutated": "VALUES(gen_random_uuid(),p_league_id,m,body)",
    "operator": "replace durable publish request ID with random ID",
    "kind": "sql"
  },
  {
    "id": "N23",
    "file": "private/notif_is_stale.sql",
    "symbol": "private.notif_is_stale(text,jsonb)",
    "original": "AND NOT m.is_finalized AND NOT m.is_voided",
    "mutated": "AND NOT m.is_voided",
    "operator": "remove finalized matchup freshness",
    "kind": "sql"
  },
  {
    "id": "N24",
    "file": "private/notif_is_stale.sql",
    "symbol": "private.notif_is_stale(text,jsonb)",
    "original": "AND abs(m.home_points-m.away_points)<=greatest(10,(m.home_points+m.away_points)*0.025)",
    "mutated": "",
    "operator": "remove close-score freshness",
    "kind": "sql"
  },
  {
    "id": "N25",
    "file": "private/notif_wake_draft_trigger.sql",
    "symbol": "private.notif_wake_draft_trigger()",
    "original": "PERFORM public.invoke_edge_function('process-trades');",
    "mutated": "NULL;",
    "operator": "remove immediate draft dispatch",
    "kind": "wake"
  },
  {
    "id": "N26",
    "file": "private/notif_wake_draft_trigger.sql",
    "symbol": "private.notif_wake_draft_trigger()",
    "original": "invoke_edge_function('process-trades')",
    "mutated": "invoke_edge_function('process-waivers')",
    "operator": "wake wrong internal worker",
    "kind": "wake"
  },
  {
    "id": "N31",
    "file": "supabase/functions/_shared/notificationDelivery.ts",
    "symbol": "createNotifyMembers",
    "original": "? await dependencies.beginWebDelivery(message, webMessage.userId) : 'send'",
    "mutated": "? 'send' : 'send'",
    "operator": "skip durable Web Push reservation before Expo starts",
    "kind": "edge"
  },
  {
    "id": "N32",
    "file": "public/notif_finish_web_atomic.sql",
    "symbol": "public.notif_finish_web_atomic(uuid,uuid,boolean)",
    "original": "(web_attempt_claim_token = p_claim_token OR claim_token = p_claim_token)",
    "mutated": "claim_token = p_claim_token",
    "operator": "require cleared Expo claim for late Web Push acknowledgement",
    "kind": "web"
  }
]
for(const kind of ['sql','wake','web','edge']) if(oracle('baseline-'+kind+'-verified-v4',kind).exit!==0) throw new Error('Baseline failed: '+kind)
for(const mutant of targets){
 const file=mutant.kind==='edge'?mutant.file:'supabase/sql/functions/by-name/'+mutant.file
 const source=readFileSync(file,'utf8')
 if(!source.includes(mutant.original)) throw new Error('Operator missing: '+mutant.id)
 const originalDefinition=mutant.kind==='edge'?source:sql(`SELECT pg_get_functiondef('${mutant.symbol}'::regprocedure)`)
 const deployedFile=mutant.kind==='edge'?file:'supabase/migrations/'+readdirSync('supabase/migrations').filter(name=>name.endsWith('.sql')).sort().reverse().find(name=>readFileSync('supabase/migrations/'+name,'utf8').includes('CREATE OR REPLACE FUNCTION '+mutant.symbol.split('(')[0]+'('))!
 const deployedSource=readFileSync(deployedFile,'utf8')
 const previous=priorResults.find(row=>row.id===mutant.id)
 const record={id:mutant.id,area:'notifications',file:deployedFile,line:deployedSource.slice(0,deployedSource.indexOf(mutant.original)).split('\n').length,symbol:mutant.symbol,operator:mutant.operator,original:mutant.original,mutated:mutant.mutated,applied:false,outcome:'invalid',oracles:(previous?.oracles??[]) as ReturnType<typeof oracle>[],killed_by:(previous?.killed_by??[]) as string[],notes:'Verified rerun: each restore hash matches before the next mutant. Earlier execution receipts remain in oracles.'}
 try{
  const mutated=source.replaceAll(mutant.original,mutant.mutated)
  if(mutant.kind==='edge') writeFileSync(file,mutated); else sql(mutated)
  record.applied=true
  const result=oracle(mutant.id+'-verified-v4',mutant.kind)
  record.oracles.push(result)
  record.outcome=result.exit===0?'survived':result.exit===-1?'timeout':'killed'
  if(record.outcome==='killed') record.killed_by.push(result.name)
 }finally{
  if(mutant.kind==='edge') writeFileSync(file,originalDefinition); else sql(originalDefinition)
  const restored=mutant.kind==='edge'?readFileSync(file,'utf8'):sql(`SELECT pg_get_functiondef('${mutant.symbol}'::regprocedure)`)
  if(hash(restored)!==hash(originalDefinition)) throw new Error('Restore hash mismatch: '+mutant.id)
 }
 const existing=priorResults.findIndex(row=>row.id===mutant.id)
 if(existing>=0) priorResults[existing]=record; else priorResults.push(record)
 writeFileSync(resultsFile,priorResults.map(row=>JSON.stringify(row)).join('\n')+'\n')
 console.log(mutant.id+' '+record.outcome)
}
for(const kind of ['sql','wake','web','edge']) if(oracle('restored-'+kind+'-verified-v4',kind).exit!==0) throw new Error('Restore failed: '+kind)
