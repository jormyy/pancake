import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
const url=process.env.SUPABASE_DB_URL
assert(url, 'SUPABASE_DB_URL is required')
assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const applicationPrefix = `pancake-taxi-choice-${process.pid}`
let serial=0
class Session {
 constructor(name){
  this.name=name;this.pending=null;this.buffer='';this.output=[]
  this.child=spawn('psql',[url,'-X','-qAt','-v','ON_ERROR_STOP=1'],{env:{...process.env,PGAPPNAME:name},stdio:['pipe','pipe','pipe']})
  this.child.stdout.on('data',chunk=>{this.buffer+=chunk;let at;while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at);this.buffer=this.buffer.slice(at+1);if(this.pending&&line===this.pending.marker){const p=this.pending;this.pending=null;p.resolve(this.output.join('\n'));this.output=[]}else this.output.push(line)}})
  this.child.stderr.on('data',chunk=>{process.stderr.write(chunk)})
  this.closed=new Promise(resolve=>this.child.on('close',code=>{if(this.pending)this.pending.reject(new Error('psql closed '+code));resolve(code)}))
 }
 /** @returns {Promise<string>} */
 query(sql){assert.equal(this.pending,null);return new Promise((resolve,reject)=>{const marker='DONE_'+(++serial);this.pending={resolve,reject,marker};this.child.stdin.write(sql+'\n\\echo '+marker+'\n')})}
 async close(){this.child.stdin.end();await this.closed}
}
const users=[randomUUID(),randomUUID()],members=[randomUUID(),randomUUID()],league=randomUUID(),season=randomUUID(),trade=randomUUID()
const root=new Session(`${applicationPrefix}-root`),acceptor=new Session(`${applicationPrefix}-acceptor`),setter=new Session(`${applicationPrefix}-setter`)
let saving,accepting,problem
try{
 await root.query(`BEGIN;
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY['${users[0]}'::uuid,'${users[1]}'::uuid])id;
 INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_veto_mode,trade_veto_window_hours) VALUES('${league}','Taxi choice concurrency','${league}','${users[0]}','active','faab','commissioner',1);
 INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES('${members[0]}','${league}','${users[0]}','commissioner','A'),('${members[1]}','${league}','${users[1]}','manager','B');
 INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2158,true);
 INSERT INTO faab_balances(league_id,league_season_id,member_id,balance) VALUES('${league}','${season}','${members[0]}',10),('${league}','${season}','${members[1]}',10) ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=10;
 INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status) VALUES('${trade}','${league}','${season}','${members[0]}','${members[1]}','pending');
 INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at) VALUES('${trade}','${members[0]}',0,true,now()),('${trade}','${members[1]}',1,false,NULL);
 INSERT INTO trade_items(trade_id,side,faab_amount,from_member_id,to_member_id) VALUES('${trade}','proposer',1,'${members[0]}','${members[1]}');COMMIT;`)
 await acceptor.query(`BEGIN; SET LOCAL statement_timeout=10000;SELECT pg_advisory_xact_lock(hashtext('${league}'),hashtext(member_id::text)) FROM trade_participants WHERE trade_id='${trade}' ORDER BY member_id;`)
 saving=setter.query(`BEGIN; SET LOCAL statement_timeout=10000; SELECT set_trade_taxi_destinations_atomic('${trade}','${members[1]}',ARRAY[]::uuid[],'${users[1]}');ROLLBACK;`).then(result=>({ok:true,result}),error=>({ok:false,error:error.message}))
 let wait=''
 for(let i=0;i<100;i++){
  wait=await root.query(`SELECT COALESCE(wait_event_type,'')||':'||COALESCE(wait_event,'') FROM pg_stat_activity WHERE application_name='${applicationPrefix}-setter';`)
  if(wait==='Lock:advisory')break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 assert.equal(wait,'Lock:advisory','setter must reach the controlled member lock')
 accepting=acceptor.query(`SELECT accept_trade_atomic('${trade}','${members[1]}');ROLLBACK;`).then(result=>({ok:true,result}),error=>({ok:false,error:error.message}))
 const results=await Promise.all([saving,accepting]);console.log(JSON.stringify({results}))
 assert(results.every(r=>r.ok),'concurrent destination save and acceptance must not deadlock')
} catch(error){problem=error} finally{
 for(const session of [setter,acceptor]){
  if(session.child.exitCode===null&&!session.pending)await session.query('ROLLBACK;').catch(()=>{})
  await session.close()
 }
 await root.query(`DELETE FROM leagues WHERE id='${league}';DELETE FROM auth.users WHERE id IN('${users[0]}','${users[1]}');`)
 await root.close();console.log('Synthetic fixture and both transaction sessions cleaned up')
}
if(problem)throw problem
