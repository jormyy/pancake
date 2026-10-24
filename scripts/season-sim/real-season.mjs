import assert from 'node:assert/strict'
import {captureSeasonFeatures,capturePlayers} from './feature-evidence.mjs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fixtureDirectory, dates } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { planDay } from './planner.mjs'
import { prepareLineups, checkLineups } from './lineups.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { assertLiveCoverage } from './invariants.mjs'
import { assertTwoCalendar, assertTwoDay } from './two-checks.mjs'
import { activateRealRookies, nbaTradeSetup, allStarLimit, realRookieActions, rookieLineups, rookieListings, rookieMoves } from './two-actions.mjs'
import { assertSkippedWeek } from './skipped-week.mjs'
import { beginWaivers, verifyWaivers, assertWaiverReset } from './waiver-scenarios.mjs'
import { waiverResetAt } from './waiver-oracle.mjs'
import { finishSeason } from './season-end.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { shiftDay } from './season-model.mjs'
import { checkPlayoffShape } from './post-oracle.mjs'

export function checkRealCoverage(profile,days,checked,rookies,observations,{through=profile.end,games=null}={}){
  assert.ok(through>=profile.start&&through<=profile.end,'The cutoff belongs to the real season')
  const selected=games?.filter(row=>row.id.startsWith(profile.prefix)&&row.date>=profile.start&&row.date<=through)
  if(through!==profile.end)assert.ok(selected,'A bounded season requires its raw game list')
  const ids=selected?new Set(selected.map(row=>row.id)):null
  assert.deepEqual(days.map(row=>row.date),dates(profile.start,through),'Every requested second-season date is verified')
  assert.equal(days.reduce((sum,row)=>sum+row.finals.games,0),selected?.length??profile.games,'Every requested real second-season final is verified')
  assert.deepEqual(checked,profile.calendar.weeks.filter(row=>row.week_number<profile.playoffStart&&row.week_number!==1&&(through===profile.end||row.week_end<=through)).map(row=>row.week_number),'Every eligible completed fantasy week closes')
  const measured=[]
  for(const rookie of rookies){
    const rows=observations.filter(row=>row.nbaId===rookie.nbaId)
    assert.deepEqual(rows.map(row=>row.gameId).sort(),rookie.gameIds.filter(id=>!ids||ids.has(id)).sort(),`Every requested real box appearance is measured: ${rookie.name}`)
    measured.push({nbaId:rookie.nbaId,name:rookie.name,games:rows.length,startedGames:rows.filter(row=>row.started===true).length,seasonPoints:rows.reduce((sum,row)=>sum+row.points,0)})
  }
  return {passed:true,through,rookies:measured,gameRows:measured.reduce((sum,row)=>sum+row.games,0),provenance:'Raw-box appearance counts and per-game independent fantasy points; not inferred from the app draft order'}
}

export function realSeasonDay(profile,date,today){
  const week=profile.calendar.weeks.find(row=>date>=row.week_start&&date<=row.week_end)
  assert.ok(week||!today.length,'Every real regular game belongs to an independent fantasy week')
  return week
}

export async function runRealSeason(c, plan, move, report, checkpoint, snapshot, liveCoverage, changeProbe, { afterRookieActivation = false } = {}) {
  const profile = plan.seasons[1], oldSeason = c.previousSeasonId
  const through=report.secondSeasonThrough??profile.end
  assert.ok(through>=profile.start&&through<=profile.end,'The cutoff belongs to the real season')
  const bounded=through!==profile.end
  if(bounded){
    const eligible=profile.calendar.weeks.find(row=>row.week_number===2)
    const third=profile.calendar.weeks.find(row=>row.week_number===3)
    assert.ok(eligible&&third&&third.week_end<=through,'The bounded path includes three complete fantasy weeks')
    c.rookieActionDates={trade:shiftDay(eligible.week_start,1),drop:third.week_start}
    report.rookieActionDates=c.rookieActionDates
  }
  const digest = () => sql(`SELECT json_build_object('stats',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.season_year=${plan.seasons[0].year}),'matchups',(SELECT md5(string_agg(row_to_json(m)::text,'' ORDER BY m.id)) FROM matchups m WHERE league_season_id='${oldSeason}'),'standings',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM standings s WHERE league_season_id='${oldSeason}'),'usedPicks',(SELECT md5(string_agg(row_to_json(p)::text,'' ORDER BY p.id)) FROM draft_picks p WHERE league_id='${c.leagueId}' AND is_used))`)
  const before = await digest()
  if (afterRookieActivation) {
    assert.equal(report.realRookieActivation?.passed, true, 'Preseason recovery requires verified rookie activation')
    assert.deepEqual(c.draftedRookies, report.realRookieActivation.rookies, 'Preseason recovery keeps the observed rookie owners')
  } else await activateRealRookies(c, plan, report)
  await checkpoint('next-season-preseason')
  await snapshot('post-draft', shiftDay(plan.seasons[0].end,1),1)
  await move(`${profile.startYear}-08-16T14:00:00Z`)
  await c.rpc(c.users[0], 'update_league_configuration_atomic', { p_league_id: c.leagueId, p_settings: { skipped_weeks: [1], playoff_start_week: profile.playoffStart } })
  const activation = await c.api(c.users[0],`/draft/${report.rookieAutoPick.draftId}/activate-rookie-league`,{})
  assert.ok(activation.activated || await sql(`SELECT status FROM leagues WHERE id='${c.leagueId}'`)==='active','A real commissioner activates the completed rookie league')
  report.realSeasonActivation = { route:'/draft/:id/activate-rookie-league',at:`${profile.startYear}-08-16T14:00:00Z` }
  c.skippedWeeks = [1]
  c.seasonYear = profile.year
  c.firstDate = profile.start
  c.seasonEnd = profile.end
  await capturePlayers(c,'preseason',report)
  report.skippedWeekSettings = { route: '/rest/v1/rpc/update_league_configuration_atomic', weeks: [1], at: `${profile.startYear}-08-16T14:00:00Z` }
  const standings = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  assert.equal(standings.length, 0, 'The real second season starts without prior standings')
  await move(`${profile.start}T14:00:00Z`)
  await c.api(c.users[0], '/sync/matchups', { leagueId: c.leagueId })
  report.secondCalendar = await assertTwoCalendar(c, profile)
  await captureSeasonFeatures(c,profile,'week-1',report)
  await capturePlayers(c,'opening-before-played',report)
  await changeProbe()
  await snapshot('next-season-start', profile.start, dates(profile.start,profile.end).length)
  const store = await fixtureStore(fixtureDirectory), games = JSON.parse(await readFile(path.join(fixtureDirectory,'games.json'),'utf8')).games
  const days = [], checked = [], began = Date.now()
  report.rookieNbaMoves = rookieMoves(plan.draft.rookies, await rookieListings(plan.draft.rookies, games.filter(row => row.id.startsWith(profile.prefix)), id => store.json(`boxscore-${id}`)), profile.year)
  report.nextSeasonProgress = { beganAt: new Date(began).toISOString(), days, provenance: 'REAL-RAW final boxes and PBP; REAL-DERIVED historical live snapshots' }
  for (const date of dates(profile.start,through)) {
    const dayBegan = Date.now(), today = games.filter(row => row.date === date), week = realSeasonDay(profile,date,today)
    const day = { date, provenance: { finals:'REAL-RAW',live:'REAL-DERIVED',actions:'SYNTHETIC',postponementAvailability:'SYNTHETIC' } }, skipped = c.skippedWeeks.includes(week?.week_number)
    await checkpoint(`${date}:real-second-season-morning`)
    await move(`${date}T14:00:00Z`)
    await verifyWaivers(c,report)
    if (date === profile.start) await beginWaivers(c,'skipped-week-rolling',report)
    if (week&&!skipped && date === week.week_start) {
      report.waiverWeekResets ??= []
      report.waiverWeekResets.push(await assertWaiverReset(c,week.week_number,waiverResetAt(week.week_end)))
      if (week.week_number === 2) await beginWaivers(c,'eligible-week-rolling',report)
    }
    await nbaTradeSetup(c,date,plan,report.rookieNbaMoves)
    await allStarLimit(c,date,profile,report)
    await realRookieActions(c,date,move,report)
    if (week&&!skipped) {
      await prepareLineups(c,date,day)
      await rookieLineups(c,date,week.week_number,today,store,report)
    }
    const planDayResult = await planDay(today,store,date,{ profile,calendar:profile.calendar,postponements:plan.postponements.timelines,playoffStart:profile.playoffStart })
    Object.assign(day,{category:planDayResult.category,plannedCheckpoints:planDayResult.events.length,minimumSnapshots:planDayResult.minimumSnapshots,requiredPeriods:planDayResult.requiredPeriods})
    for (const event of planDayResult.events) {
      report.events[event.type]=(report.events[event.type]??0)+1
      await move(event.at)
      if (skipped) await assertSkippedWeek(c,1)
      else await checkLineups(c,date,day)
    }
    const next = shiftDay(date,1)
    await move(`${next}T09:00:00Z`)
    day.finals = today.length ? await assertFinals(date) : { games:0 }
    day.coverage = assertLiveCoverage(liveCoverage(),today,planDayResult)
    day.points = skipped ? await assertSkippedWeek(c,1) : today.length ? await assertLeaguePoints({ ...c,date }) : null
    if (week&&!skipped) await assertClientScores(c,{week:week.week_number})
    day.weekly = await assertClosedWeeks(c,next,checked)
    await verifyWaivers(c,report)
    if(!report.playersEvidence.some(row=>row.year===profile.year&&row.label==='after-first-final'))await capturePlayers(c,'after-first-final',report)
    if(!report.featureCheckpoints.some(row=>row.year===profile.year&&row.label==='mid-season')&&week?.week_number>=Math.floor(profile.playoffStart/2))await captureSeasonFeatures(c,profile,'mid-season',report)
    day.realInputs = await assertTwoDay(c,date,report,plan,store,today)
    if (report.realRookieActions?.bench && day.realInputs.identities.some(row => row.playerId===report.realRookieActions.bench.playerId && row.started===false)) report.realRookieActions.bench.measured=true
    day.skippedWeek = await assertSkippedWeek(c,1)
    for(const pick of [...report.actions.tradeDeadline.transferredPicks,{id:report.offseasonTrade.pickId,owner:report.offseasonTrade.owner},{id:report.offseasonTrade.counterPickId,owner:report.offseasonTrade.counterOwner}])assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick.id}'`),pick.owner,'Traded future picks retain their owners through the second real season')
    assert.equal(await digest(),before,'Real second-season play preserves all settled first-season history')
    day.wallSeconds=(Date.now()-dayBegan)/1000
    days.push(day)
    console.log(JSON.stringify({realSeasonDate:date,games:day.finals.games,wallSeconds:day.wallSeconds}))
    await checkpoint(`${date}:real-second-season-verified`)
  }
  if(!bounded){
    const ending = { actions: {}, phaseTimings: [], featureCheckpoints:report.featureCheckpoints }
    report.secondSeasonEnd = await finishSeason(c,move,ending,checkpoint,{ stopAfterChampion:true,snapshot:async(name,...args)=>snapshot(`season-${profile.year}-${name}`,...args) })
    report.secondChampion = ending.champion
    report.secondPlayoffs=checkPlayoffShape(await c.rest(c.users[0],`matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&matchup_type=neq.regular_season&is_voided=eq.false`),c.users.length,profile.playoffStart,[1,2])
  }
  await capturePlayers(c,'requested-end',report)
  report.realRookieCoverage=checkRealCoverage(profile,days,checked,plan.draft.rookies,report.realInputChecks.filter(row=>row.year===profile.year).flatMap(row=>row.identities).filter(row=>plan.draft.rookies.some(rookie=>rookie.nbaId===row.nbaId)),{through,games})
  assert.ok(report.realRookieCoverage.rookies.some(row=>row.startedGames>0),'Real drafted rookies have measured eligible starter games')
  const traded=report.realRookieActions?.trade
  assert.ok(traded&&report.realInputChecks.flatMap(row=>row.identities).some(row=>row.playerId===traded.playerId&&row.owner===traded.owner&&row.started===true&&row.points!==0&&row.date>new Date(traded.at).toISOString().slice(0,10)),'A fantasy-traded rookie scores for its new owner in later games')
  assert.ok(report.realRookieActions?.bench?.measured && report.realRookieActions?.trade?.passed && report.realRookieActions?.readd?.passed,'All real rookie manager actions must be measured')
  assert.deepEqual((c.nbaTradeSubjects ?? []).filter(row => row.year === profile.year && !row.verified).map(row => row.nbaId), [], 'Every raw-box NBA move of a fantasy-held player keeps its row and owner and scores for the new team')
  const afterCounts = await sqlJson(`SELECT json_agg(json_build_object('year',season_year,'games',count)) FROM (SELECT season_year,count(*) AS count FROM nba_games WHERE status='Final' GROUP BY season_year) q`,'Two-season final counts')
  for (const row of plan.seasons) assert.equal(afterCounts.find(value=>value.year===row.year)?.games,row.year===profile.year?games.filter(game=>game.id.startsWith(profile.prefix)&&game.date<=through).length:row.games)
  return { passed:true,days,checked,historyPreserved:true,skippedWeeks:[1],through,bounded,provenance:'Real NBA regular-season games through the requested cutoff; historical live reconstruction is REAL-DERIVED; manager actions are SYNTHETIC' }
}
