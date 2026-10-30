import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import path from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'

assert.match(readFileSync('supabase/config.toml','utf8'),/^project_id = "pt4bafablesr"$/m)
const url='postgresql://postgres:postgres@127.0.0.1:64222/postgres'
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const json=input=>JSON.parse(sql(input))
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const snapshot=()=>json(`SELECT jsonb_build_object('workRows',(SELECT md5(jsonb_agg(to_jsonb(w) ORDER BY id)::text) FROM private.work_items w),
  'serviceHistory',(SELECT jsonb_object_agg(kind,last_claimed_at) FROM private.work_kinds WHERE last_claimed_at IS NOT NULL),
  'cron',current_setting('cron.launch_active_jobs'));`)
assert.equal(json("SELECT count(*) FROM private.work_items WHERE status='running';"),0)
const before=snapshot()
assert.equal(before.cron,'off')
for(let run=0;run<2;run++)sql(readFileSync('supabase/migrations/20261214005408_background_kind_fairness.sql','utf8'))
assert.deepEqual(snapshot(),before,'Repeating the migration changed work or service history')
execFileSync('docker',['restart','supabase_db_pt4bafablesr'],{encoding:'utf8'})
let ready=false
for(let attempt=0;attempt<30;attempt++){
  try{sql('SELECT 1;');ready=true;break}catch{await pause(1000)}
}
assert.ok(ready)
assert.deepEqual(snapshot(),before,'Restart changed committed work or service history')
const id=json("SELECT private.work_enqueue('process-waivers','worker-restart-lease',now(),'{\"restartLease\":true}');")
const first=json(`SELECT to_jsonb(w) FROM private.work_claim(1) w;`)
assert.equal(first.id,id)
sql(`UPDATE private.work_items SET lease_until=now()-interval '1 second' WHERE id=${id}; SELECT private.work_claim(0);`)
const retry=json(`SELECT jsonb_build_object('status',status,'attempts',attempts,'future',due_at>now()) FROM private.work_items WHERE id=${id};`)
assert.deepEqual(retry,{status:'failed',attempts:1,future:true})
assert.equal(sql(`SELECT private.work_finish(${id},${literal(first.lease_token)});`),'f')
sql(`UPDATE private.work_items SET due_at=now() WHERE id=${id};`)
const second=json('SELECT to_jsonb(w) FROM private.work_claim(1) w;')
assert.equal(second.id,id);assert.equal(second.attempts,2);assert.notEqual(second.lease_token,first.lease_token)
assert.equal(sql(`SELECT private.work_finish(${id},${literal(first.lease_token)});`),'f')
assert.equal(sql(`SELECT private.work_finish(${id},${literal(second.lease_token)});`),'t')
const result={migrationIdempotent:true,committedWorkPreserved:true,serviceHistoryPreserved:true,cronStayedDisabled:true,
  retryBackoffPreserved:true,expiredTokenRejected:true,retryTokenChanged:true,retryCompleted:true,
  serviceKinds:Object.keys(before.serviceHistory).sort()}
writeFileSync(path.join(homedir(),'pancake-t_4ba51e0d/lanes/fable-ui27/evidence/worker-restart.json'),JSON.stringify(result,null,2)+'\n')
process.stdout.write(JSON.stringify(result)+'\n')
