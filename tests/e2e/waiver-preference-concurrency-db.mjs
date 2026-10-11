import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
const url=process.env.SUPABASE_DB_URL
assert(url, 'SUPABASE_DB_URL is required')
assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const applicationPrefix = `pancake-waiver-preference-${process.pid}`
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
const user=randomUUID(),league=randomUUID(),season=randomUUID(),member=randomUUID(),first=randomUUID(),preferred=randomUUID()
const root=new Session(`${applicationPrefix}-root`),editor=new Session(`${applicationPrefix}-editor`),processor=new Session(`${applicationPrefix}-processor`)
try{
 await root.query(`BEGIN;
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES('${user}','authenticated','authenticated','${user}@example.test','x',now(),'{}','{}',now(),now());
 INSERT INTO leagues(id,name,slug,commissioner_id,status,waiver_mode,weekly_add_limit,roster_size) VALUES('${league}','Reorder concurrency','${league}','${user}','active','faab',NULL,2);
 INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES('${member}','${league}','${user}','commissioner','Preference Team');
 INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2114,true);
 INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES('${league}','${season}','${member}',1);
 INSERT INTO faab_balances(league_id,league_season_id,member_id,balance) VALUES('${league}','${season}','${member}',5) ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=5;
 INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team) VALUES('${first}','Former','First','PG',ARRAY['PG'],'Active','XCP'),('${preferred}','New','First','SG',ARRAY['SG'],'Active','XCP');
 INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at) VALUES('${league}','${season}','${first}',now()-interval '1 hour',now()+interval '47 hours'),('${league}','${season}','${preferred}',now()-interval '1 hour',now()+interval '47 hours');
 SELECT create_waiver_claim_atomic('${league}','${member}','${first}',NULL,'${user}',5,2);
 SELECT create_waiver_claim_atomic('${league}','${member}','${preferred}',NULL,'${user}',5,3);
 UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id='${league}';
 UPDATE waiver_claims SET process_date=current_date-1 WHERE league_id='${league}';COMMIT;`)
 const claim=(await root.query(`SELECT id FROM waiver_claims WHERE member_id='${member}' AND player_id='${preferred}';`)).trim()
 await editor.query(process.argv.includes('--edit') ? `BEGIN; SELECT edit_waiver_claim_atomic('${claim}','${member}','${user}',NULL,5,1);` : `BEGIN; SELECT reorder_waiver_claim_atomic('${claim}','${member}','${user}','up');`)
 let finished=false
 const processing=processor.query('SET statement_timeout=10000; SELECT row_to_json(r) FROM process_next_waiver_claim_atomic(current_date) r;').then(result=>{finished=true;return result})
 let lock=''
 for(let i=0;i<50&&!finished;i++){
  lock=await root.query(`SELECT COALESCE(wait_event_type,'')||':'||COALESCE(wait_event,'') FROM pg_stat_activity WHERE application_name='${applicationPrefix}-processor';`)
  if(lock.startsWith('Lock:'))break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 console.log(JSON.stringify({processorFinishedBeforeCommit:finished,observedWait:lock}))
 await editor.query('COMMIT;')
 console.log(JSON.stringify({initialProcessing:await processing}))
 await root.query('SELECT count(*) FROM process_due_waiver_claims_atomic(current_date,100);')
 const state=JSON.parse(await root.query(`SELECT json_build_object('claims',(SELECT json_agg(json_build_object('player',player_id,'status',status,'order',claim_order)) FROM waiver_claims WHERE league_id='${league}'),'winner',(SELECT player_id FROM roster_players WHERE league_id='${league}'),'balance',(SELECT balance FROM faab_balances WHERE member_id='${member}'));`))
 console.log(JSON.stringify({state,preferred}))
 assert.equal(state.winner,preferred,'committed reorder must control the eventual award')
 assert.equal(state.balance,0)
}finally{
 if(editor.child.exitCode===null&&!editor.pending)await editor.query('ROLLBACK;')
 await editor.close();await processor.close()
 await root.query(`DELETE FROM leagues WHERE id='${league}';DELETE FROM players WHERE id IN('${first}','${preferred}');DELETE FROM auth.users WHERE id='${user}';`)
 await root.close()
}
