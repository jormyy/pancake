import assert from'node:assert/strict'
import{execFileSync,spawnSync}from'node:child_process'
import{readFile,writeFile,realpath}from'node:fs/promises'
import{homedir}from'node:os'
import path from'node:path'
import{config,miniRoot,fixtureDirectory,laneDirectory,writeJson}from'./common.mjs'
import{setupStack,clearOwnBackup,localKeys,sql,sqlJson}from'./local-stack.mjs'
import{startRuntime}from'./runtime.mjs'
import{setClock}from'./clock.mjs'
import{advanceCron}from'./cron.mjs'
import{cronDispatcher}from'./cron-dispatcher.mjs'
import{scenarioLeague}from'./draft-probe.mjs'
import{rookieDraftOptions}from'./draft-options.mjs'
import{playRookieTurns}from'./rookie-turns.mjs'
import{registerPushOwners,captureDraftPushes}from'./push-evidence.mjs'
import{sourceEvidence}from'./source-manifest.mjs'
import{calendarOracle}from'./calendar-oracle.mjs'

export function assertSupplemental(configuration=config){
  assert.equal(configuration.root,path.join(homedir(),'pancake-t_4ba51e0d/lanes/sim-supp'))
  assert.equal(configuration.project,'pt4basimx')
  assert.equal(configuration.prefix,'581')
}

export function checkSkippedDraft(picks,status){
  assert.equal(picks.length,8)
  assert.equal(status,'completed')
  assert.ok(picks[0].skipped_at&&!picks[0].picked_at&&!picks[0].player_id)
  assert.ok(picks.slice(1).every(pick=>pick.picked_at&&pick.player_id&&!pick.skipped_at))
  assert.ok(picks.every(pick=>pick.timer_expires_at==null))
  return{passed:true,picks:8,skipped:1,selected:7}
}

export function checkUnstartedBackstop(draft,picks){
  assert.equal(draft.status,'completed')
  assert.equal(draft.pick_timer_seconds,60)
  assert.equal(picks.length,12)
  assert.ok(picks.every(pick=>pick.player_id&&pick.picked_at&&!pick.skipped_at&&pick.timer_expires_at==null))
  return{passed:true,picks:12,timerSeconds:60}
}

async function primaryFingerprint(){
  const tables=['leagues','league_members','league_seasons','nba_games','player_game_stats','matchups','standings','draft_picks','roster_players']
  return sqlJson(`SELECT json_build_object(${tables.flatMap(table=>[`'${table}'`,`(SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY r.id),'')) FROM ${table} r)`]).join(',')})`,'Ancillary primary-table fingerprint')
}

export async function runAncillary(catalog,{execute=sql,fingerprint=primaryFingerprint}={}){
  const results=[]
  for(const name of ['league-inventory-hint-drain','mock-room-expiry','pg-net-response-vacuum','retention-prune']){
      const job=catalog.find(row=>row.jobname===name);assert.ok(job,`Expected ancillary job ${name}`)
      const transactional=!/^\s*VACUUM\b/i.test(job.command)
      await execute(transactional?"BEGIN; SET LOCAL statement_timeout='15s'":"SET statement_timeout='15s'")
      try{
        const before=await fingerprint();await execute(job.command);assert.deepEqual(await fingerprint(),before)
        results.push({id:name,passed:true,command:job.command,scope:'Transactional smoke; primary tables unchanged. No expired mock fixture or retention backlog is claimed.'})
      }finally{await execute(transactional?'ROLLBACK':'RESET statement_timeout')}
    }
  return results
}

export async function runSupplemental({scenario='all'}={}){
  assert.ok(['all','paused-notification'].includes(scenario))
  assertSupplemental()
  assert.equal(await realpath(process.cwd()),path.join(miniRoot,'repo'),'Supplemental writes require the separate extracted checkout')
  assert.equal(process.env.SEASON_SIM_MODE,'two-season')
  const directory=await laneDirectory(path.join(miniRoot,'evidence/r11'))
  const report={scope:'SYNTHETIC prepared states, real board and product API/cron; bounded supplement, not the protected replay',startedAt:new Date().toISOString(),source:await sourceEvidence(),outcomes:[],checks:[],exit:1}
  const began=Date.now();let runtime
  try{
    execFileSync(config.cli,['stop','--project-id',config.project,'--no-backup'],{stdio:'inherit'})
    report.backupRemoved=await clearOwnBackup();await setupStack()
    const keys=localKeys();process.env.SUPABASE_DB_URL=keys.DB_URL
    if(scenario==='all'){
    const recipeBegan=Date.now(),recipe=spawnSync('psql',[keys.DB_URL,'-Xv','ON_ERROR_STOP=1','-f','tests/db/general-playoff-brackets.sql'],{encoding:'utf8',timeout:120000})
    await writeFile(path.join(directory,'nonzero-byes.log'),(recipe.stdout??'')+(recipe.stderr??''))
    report.checks.push({id:'nonzero-bye',passed:recipe.status===0,command:'psql "$SUPABASE_DB_URL" -Xv ON_ERROR_STOP=1 -f tests/db/general-playoff-brackets.sql',exit:recipe.status,seconds:(Date.now()-recipeBegan)/1000,scope:'Transactional SQL recipe; entrant counts 2,4,6,10,12,16,24,33; not a continuous historical replay'})
    assert.equal(recipe.status,0,'Nonzero-bye recipe must pass')
    const games=JSON.parse(await readFile(path.join(fixtureDirectory,'games.json'),'utf8')).games
    const calendars=[2025,2026].map(year=>({year,...calendarOracle(games.filter(game=>game.id.startsWith('002'+String(year-1).slice(-2))))}))
    const calendarRows=calendars.flatMap(calendar=>calendar.weeks.map(week=>`(${calendar.year},${week.week_number},'${week.week_start}','${week.week_end}')`)).join(',')
    const eliminationSource=await readFile(new URL('./supplemental-elimination.sql',import.meta.url),'utf8')
    const eliminated=spawnSync('psql',[keys.DB_URL,'-Xv','ON_ERROR_STOP=1'],{input:`BEGIN; CREATE TEMP TABLE supp_calendar(season_year int,week_number int,week_start date,week_end date); INSERT INTO supp_calendar VALUES ${calendarRows};\n`+eliminationSource,encoding:'utf8',timeout:120000})
    await writeFile(path.join(directory,'eliminated-both.log'),(eliminated.stdout??'')+(eliminated.stderr??''))
    report.checks.push({id:'eliminated-both',passed:eliminated.status===0,exit:eliminated.status,calendars,scope:'Transactional SQL publication/consumption guard on both independently derived real calendars; SYNTHETIC league and future stat inputs; not an Edge ingestion replay'})
    assert.equal(eliminated.status,0,'Both real-calendar eliminated-team guards must pass')
    }
    runtime=await startRuntime('2025-06-28T12:59:00Z')
    let clock=Date.parse('2025-06-28T12:59:00Z')
    const dispatcher=cronDispatcher(async row=>{
      report.outcomes.push({...row,businessAt:new Date(clock).toISOString()})
      if(['sync-rankings','sync-projections'].includes(row.function_name))return
      assert.equal(row.status_code,200,JSON.stringify(row));assert.equal(row.worker_status,'success',JSON.stringify(row))
    })
    const move=async value=>{const to=typeof value==='number'?value:Date.parse(value);await advanceCron({from:clock,to,move:async at=>{clock=at;await setClock({at:new Date(at).toISOString(),rate:0,quiet:true})},invoke:dispatcher.enqueue,settle:dispatcher.settle});clock=to}
    const jump=async at=>{clock=Date.parse(at);await setClock({at,rate:0,quiet:true})}
    await move('2025-06-28T13:03:00Z')
    const skipped=await scenarioLeague(keys),unstarted=scenario==='all'?await scenarioLeague(keys):null
    report.registration=await registerPushOwners(skipped,keys)
    if(scenario==='paused-notification'){
      const {draft}=await skipped.api(skipped.users[0],'/draft/start-rookie',{leagueId:skipped.leagueId,...rookieDraftOptions()})
      await skipped.api(skipped.users[0],`/draft/${draft.id}/pause`,{})
      await move('2025-06-28T13:04:00Z')
      await move('2025-06-28T13:04:30Z')
      await skipped.api(skipped.users[0],`/draft/${draft.id}/resume`,{})
      await move('2025-06-28T13:05:00Z');await dispatcher.drain(clock)
      report.pausedNotification=await sqlJson(`SELECT json_build_object('draft',(SELECT row_to_json(d) FROM drafts d WHERE id='${draft.id}'),'pick',(SELECT row_to_json(p) FROM snake_draft_picks p WHERE draft_id='${draft.id}' AND overall_pick=1),'outbox',(SELECT json_agg(o) FROM notification_outbox o WHERE data->>'draftId'='${draft.id}' AND event_type='draft_on_clock'))`,'Paused and resumed on-clock notification')
      const sent=(await readFile(path.join(miniRoot,'evidence/expo-transport.jsonl'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return''})).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.kind==='push'&&row.data?.pickId===report.pausedNotification.pick.id)
      report.pausedNotification.sent=sent
      report.pausedNotification.staleNow=await sqlJson(`SELECT to_json(coalesce(bool_or(private.notif_is_stale(event_type,data)),false)) FROM notification_outbox WHERE data->>'draftId'='${draft.id}' AND event_type='draft_on_clock'`,'Current resumed-pick staleness')
      report.checks.push({id:'notification-paused',passed:sent.length===1,observed:report.pausedNotification,scope:'Real pause, minute dispatch, resume and next minute; first pick remains current with thirty seconds left'})
      assert.equal(report.pausedNotification.draft.status,'in_progress')
      assert.ok(Date.parse(report.pausedNotification.pick.timer_expires_at)>clock)
      assert.equal(sent.length,1,'A resumed current pick receives its on-clock alert before its deadline')
      report.exit=0
      return report
    }
    const {draft}=await skipped.api(skipped.users[0],'/draft/start-rookie',{leagueId:skipped.leagueId,...rookieDraftOptions(),timerExpiryBehavior:'skip_pick'})
    const phaseBegan=Date.now()
    try{await playRookieTurns(skipped,draft.id,move,report,{firstExpiry:'skip_pick'})}
    catch(error){
      if(!error.message.includes('Draft push receipts must settle'))throw error
      report.notificationFailure={name:error.name,message:error.message,scope:'Strict F6 failure retained; continuing independent supplemental areas only'}
    }
    const readDraft=async id=>sqlJson(`SELECT json_build_object('draft',(SELECT row_to_json(d) FROM drafts d WHERE id='${id}'),'picks',(SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${id}'))`,'Supplemental draft result')
    const skipState=await readDraft(draft.id)
    report.skip={...checkSkippedDraft(skipState.picks,skipState.draft.status),state:skipState,businessAt:new Date(clock).toISOString()}
    await captureDraftPushes(skipped,draft.id,report)
    report.onClockRows=await sqlJson(`SELECT json_agg(o) FROM notification_outbox o WHERE event_type='draft_on_clock' AND data->>'draftId'='${draft.id}'`,'Suppressed on-clock events')
    report.checks.push({id:'skip-expiry',...report.skip,seconds:(Date.now()-phaseBegan)/1000})
    assert.ok(unstarted)
    assert.equal(Number(await sql(`SELECT count(*) FROM drafts WHERE league_id='${unstarted.leagueId}'`)),0,'No commissioner starts the backstop league draft')
    await jump('2025-10-20T09:59:00Z')
    await move('2025-10-20T10:10:00Z')
    await jump('2025-10-21T12:59:00Z')
    const backstopBegan=Date.now()
    await move('2025-10-21T13:16:00Z');await dispatcher.drain(clock)
    const draftId=await sql(`SELECT id FROM drafts WHERE league_id='${unstarted.leagueId}'`)
    assert.ok(draftId,'The production boundary starts the missing rookie draft')
    const backstop=await readDraft(draftId)
    report.backstop={rule:'First production boundary at opening-night 09:00 ET; published opening supersedes the unpublished-week fallback',...checkUnstartedBackstop(backstop.draft,backstop.picks),state:backstop,businessAt:new Date(clock).toISOString()}
    report.checks.push({id:'unstarted-backstop',...report.backstop,seconds:(Date.now()-backstopBegan)/1000})
    const catalog=JSON.parse(await readFile(path.join(miniRoot,'cron-jobs.json'),'utf8'))
    report.ancillary=await runAncillary(catalog)
    report.exit=report.draftPushes?.status==='PASS'?0:1
  }catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
  finally{
    await runtime?.close()
    try{process.env.SUPABASE_DB_URL=localKeys().DB_URL;const source=await readFile('scripts/season-sim/restore-clock.sql','utf8');await sql(source.slice(source.indexOf('BEGIN;')));report.clockRestored=true}catch(error){report.clockError=error.message;report.exit=1}
    try{execFileSync(config.cli,['stop','--project-id',config.project],{stdio:'inherit'});report.stackStopped=true}catch(error){report.stackError=error.message;report.exit=1}
    report.seconds=(Date.now()-began)/1000;report.finishedAt=new Date().toISOString()
    await writeJson(path.join(directory,'supplemental.json'),report)
    for(const row of report.checks)console.log(`${row.id}: ${row.passed?'PASS':'FAILED'}`)
    console.log(JSON.stringify({exit:report.exit,seconds:report.seconds,failure:report.failure,clockRestored:report.clockRestored,stackStopped:report.stackStopped}))
  }
  return report
}
