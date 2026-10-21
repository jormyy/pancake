import assert from'node:assert/strict'
import{randomBytes}from'node:crypto'
import{execFileSync}from'node:child_process'
import{readFile}from'node:fs/promises'
import path from'node:path'
import{config,miniRoot,writeJson,assertTarget}from'./common.mjs'
import{setupStack,clearOwnBackup,localKeys,sql,sqlJson}from'./local-stack.mjs'
import{startRuntime}from'./runtime.mjs'
import{setClock}from'./clock.mjs'
import{advanceCron}from'./cron.mjs'
import{cronDispatcher}from'./cron-dispatcher.mjs'
import{actionClient}from'./actions.mjs'
import{registerPushOwners,captureDraftPushes}from'./push-evidence.mjs'
import{playRookieTurns}from'./rookie-turns.mjs'
import{rookieDraftOptions}from'./draft-options.mjs'
import{checkDraftCutoff}from'./feature-oracles.mjs'
import{capturePlayers}from'./feature-evidence.mjs'
import{twoPlan}from'./two-checks.mjs'
import{sourceEvidence}from'./source-manifest.mjs'

export function openingCutoff(date){
  let at=Date.parse(`${date}T09:00:00Z`)
  const hour=Number(new Date(at).toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}))
  at+=(9-hour)*3600000
  return at
}

async function scenarioLeague(keys){
  assertTarget(keys.API_URL,'api')
  const client=actionClient(keys),users=[]
  for(let i=0;i<4;i++){
    const email=`season-sim-draft-${randomBytes(8).toString('hex')}@example.test`,password=randomBytes(24).toString('hex')
    const created=await fetch(`${keys.API_URL}/auth/v1/admin/users`,{method:'POST',headers:{apikey:keys.SERVICE_ROLE_KEY,Authorization:`Bearer ${keys.SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true}),redirect:'error'})
    assert.ok(created.ok)
    const login=await fetch(`${keys.API_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:keys.ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password}),redirect:'error'})
    assert.ok(login.ok)
    const session=await login.json();users.push({memberId:'',id:session.user.id,token:session.access_token,refreshToken:session.refresh_token,expiresAt:Date.now()+session.expires_in*1000})
  }
  const league=await client.rpc(users[0],'create_league',{p_name:'Synthetic prepared offseason draft',p_team_name:'Home',p_auction_budget:20})
  for(const user of users.slice(1))await client.rpc(user,'join_league_by_invite_code',{p_invite_code:league.invite_code,p_team_name:'Away'})
  await client.rpc(users[0],'update_league_configuration_atomic',{p_league_id:league.id,p_settings:{roster_size:3,taxi_slots:4}})
  const members=await client.rest(users[0],`league_members?select=id,user_id&league_id=eq.${league.id}`)
  for(const user of users)user.memberId=members.find(row=>row.user_id===user.id).id
  const leagueSeasonId=await sql(`SELECT id FROM league_seasons WHERE league_id='${league.id}' AND is_current`)
  await sql(`UPDATE leagues SET status='offseason' WHERE id='${league.id}'; UPDATE league_seasons SET season_year=2026 WHERE id='${leagueSeasonId}'`)
  return{...client,users,leagueId:league.id,leagueSeasonId,seasonYear:2026}
}

export function draftProbePlan(phase){
  assert.ok(['both','turns','cutoff'].includes(phase),'Choose both, turns or cutoff')
  return {turns:phase!=='cutoff',cutoff:phase!=='turns'}
}

export async function probeRookieDraft({phase='both'}={}){
  const selected=draftProbePlan(phase)
  assert.equal(process.env.SEASON_SIM_MODE,'two-season','The draft probe uses the pinned real NBA class')
  const began=Date.now(),report={scope:'Bounded SYNTHETIC prepared offseason state; real class, APIs, cron, expiry and cutoff. No continuous-season claim.',phaseTimings:[],outcomes:[],exit:1}
  let runtime
  report.source=await sourceEvidence()
  try{
    execFileSync(config.cli,['stop','--project-id',config.project,'--no-backup'],{stdio:'inherit'})
    report.backupRemoved=await clearOwnBackup();await setupStack()
    runtime=await startRuntime('2025-06-28T12:59:00Z')
    let clock=Date.parse('2025-06-28T12:59:00Z')
    const dispatcher=cronDispatcher(async row=>{
      report.outcomes.push(row)
      if(['sync-rankings','sync-projections'].includes(row.function_name)){if(row.status_code!==200)(report.ancillaryGaps??=[]).push(row);return}
      assert.equal(row.status_code,200,JSON.stringify(row));assert.equal(row.worker_status,'success',JSON.stringify(row))
    })
    const move=async value=>{const at=typeof value==='number'?value:Date.parse(value);await advanceCron({from:clock,to:at,move:time=>setClock({at:new Date(time).toISOString(),rate:0,quiet:true}),invoke:dispatcher.enqueue,settle:dispatcher.settle});clock=at}
    await move('2025-06-28T13:03:00Z')
    const normal=selected.turns?await scenarioLeague(runtime.keys):null
    if(normal)report.normalRegistration=await registerPushOwners(normal,runtime.keys)
    const cutoffLeague=selected.cutoff?await scenarioLeague(runtime.keys):null
    report.cutoffPreparation='A second league is created in the prior setup season, so real future allocation supplies its current-year rookie picks after the declared prepared rollover.'
    if(normal){
    const firstBegan=Date.now()
    const started=await normal.api(normal.users[0],'/draft/start-rookie',{leagueId:normal.leagueId,...rookieDraftOptions()})
    report.warning60=started.warning
    const draftId=started.draft.id
    await playRookieTurns(normal,draftId,move,report)
    await captureDraftPushes(normal,draftId,report)
    report.phaseTimings.push({phase:'sixty-second-rookie-draft',seconds:(Date.now()-firstBegan)/1000,businessAt:new Date(clock).toISOString(),pauses:report.rookiePause.length})
    report.normalPushStatus=report.draftPushes.status
    await dispatcher.drain(clock)
    }
    if(cutoffLeague){
    clock=Date.parse('2025-10-20T09:59:00Z');await setClock({at:new Date(clock).toISOString(),rate:0,quiet:true})
    report.cutoffSetupClockJump='SYNTHETIC independent prepared-state scenario; no intervening cadence coverage claimed'
    await move('2025-10-20T10:10:00Z')
    const profile=(await twoPlan()).seasons[1]
    await capturePlayers(cutoffLeague,'prepared-preseason',report)
    const cutoff=openingCutoff(profile.start)
    const body={leagueId:cutoffLeague.leagueId,...rookieDraftOptions(604800)}
    const warning=await cutoffLeague.api(cutoffLeague.users[0],'/draft/rookie-start-warning',body)
    report.cutoffWarning=warning.warning
    const start=await cutoffLeague.api(cutoffLeague.users[0],'/draft/start-rookie',body)
    report.cutoffDraftId=start.draft.id
    const cutoffBegan=Date.now()
    await move(cutoff-60000)
    const pending=Number(await sql(`SELECT count(*) FROM snake_draft_picks WHERE draft_id='${start.draft.id}' AND picked_at IS NULL AND skipped_at IS NULL`))
    assert.equal(pending,8,'All long-timer picks remain unfinished before opening-night cutoff')
    await move(cutoff+60000);await dispatcher.drain(clock)
    const state=await sqlJson(`SELECT json_build_object('picks',(SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${start.draft.id}'),'audits',(SELECT json_agg(a) FROM draft_audit_logs a WHERE draft_id='${start.draft.id}'),'status',(SELECT status FROM drafts WHERE id='${start.draft.id}'))`,'F4 opening-night production result')
    report.cutoff=checkDraftCutoff({...state,warning:warning.warning,cutoff,at:clock})
    report.cutoffRows=state
    report.phaseTimings.push({phase:'opening-night-cutoff',seconds:(Date.now()-cutoffBegan)/1000,businessAt:new Date(clock).toISOString()})
    }
    report.exit=(!selected.turns||report.draftPushes.status==='PASS')&&(!selected.cutoff||report.cutoff.passed)?0:1
  }catch(error){
    report.failure={name:error.name,message:error.message,stack:error.stack}
    if(report.cutoffDraftId)try{
      report.cutoffRows=await sqlJson(`SELECT json_build_object('picks',(SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${report.cutoffDraftId}'),'audits',(SELECT json_agg(a) FROM draft_audit_logs a WHERE draft_id='${report.cutoffDraftId}'),'status',(SELECT status FROM drafts WHERE id='${report.cutoffDraftId}'))`,'Cutoff state after a failed production worker')
      const at=Number(await sql('SELECT extract(epoch FROM now())*1000'))
      report.cutoff=checkDraftCutoff({...report.cutoffRows,warning:report.cutoffWarning,cutoff:Date.parse(report.cutoffWarning.openingNightCutoff),at})
    }catch(observed){report.cutoffReadError=observed.message}
  }
  finally{
    await runtime?.close()
    try{process.env.SUPABASE_DB_URL=localKeys().DB_URL;const source=await readFile('scripts/season-sim/restore-clock.sql','utf8');await sql(source.slice(source.indexOf('BEGIN;')));report.clockRestored=true}catch(error){report.clockError=error.message}
    try{execFileSync(config.cli,['stop','--project-id',config.project],{stdio:'inherit'});report.stackStopped=true}catch(error){report.stackError=error.message}
    report.seconds=(Date.now()-began)/1000
    await writeJson(path.join(miniRoot,'evidence/draft-probe.json'),report)
    console.log(`F4 cutoff: ${report.cutoff?.passed?'PASS':report.cutoffWarning?'FAILED':'not measured'}`)
    console.log(JSON.stringify({exit:report.exit,seconds:report.seconds,failure:report.failure,phaseTimings:report.phaseTimings}))
  }
  return report
}
