import assert from 'node:assert/strict'
import {captureSeasonFeatures,capturePlayers} from './feature-evidence.mjs'
import {registerPushOwners} from './push-evidence.mjs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { assertFinals, assertLeaguePoints, captureLoad, resetLoad } from './assertions.mjs'
import { assertDomain, assertLiveCoverage, assertHistoricalTeams } from './invariants.mjs'
import { actionClient, createLeagueActions } from './actions.mjs'
import { prepareLineups, checkLineups } from './lineups.mjs'
import { startRuntime } from './runtime.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { cronDispatcher } from './cron-dispatcher.mjs'
import { sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { fixtureDirectory, dates, etDate, miniRoot, season as fallbackSeason, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { clockTime } from './virtual-clock.mjs'
import { planDay } from './planner.mjs'
import { finishSeason, finishRookieDraft } from './season-end.mjs'
import { advanceCron, verifyCronCatalog, productionJobs } from './cron.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { startRealtimeProbe } from './realtime-probe.mjs'
import { saveSnapshot, waitForSnapshotWorkers } from './checkpoints.mjs'
import { runNextSeason } from './next-season.mjs'
import { tradeScenarios } from './trade-scenarios.mjs'
import { applyOverlay, functionFingerprint } from './overlay.mjs'
import { assertWaiverRollover, beginWaivers, verifyWaivers } from './waiver-scenarios.mjs'
import { acceptanceGaps } from './report-summary.mjs'
import { twoPlan, assertTwoCalendar, assertTwoDay, assertPublishedCalendar, draftSourceUnavailable } from './two-checks.mjs'
import { nbaTradeSetup, allStarLimit, rookieLineups } from './two-actions.mjs'
import { runRealSeason } from './real-season.mjs'
import { shiftDay } from './season-model.mjs'
import { waiverBoundaryDeferral } from './maintenance.mjs'
import { assertSkippedWeek, isSkippedWeek } from './skipped-week.mjs'
import { recoveryHistoryQuery, draftRecoveryFields, openingRecoveryFields, realSecondRecoveryFields, postDraftStateQuery } from './recovery.mjs'

export async function replay(options = {}) {
  const realPlan = await twoPlan(), profile = realPlan?.seasons[0]
  // A real launch replays season one over the range its pinned schedule gives (prepare-two.mjs), not the fallback table.
  const season = profile ?? fallbackSeason
  assert.ok(!realPlan||!options.resume||options.recoveryEvidence,'A real-season resume requires validated recovery evidence')
  const start = options.resume?.date ?? options.start ?? (options['late-season'] ? shiftDay(season.end,-27) : season.start)
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(['next-season-start', 'post-draft', 'real-second-season'].includes(options.segment) || start >= season.start && start <= season.end)
  const selected = ['post-draft','next-season-start','real-second-season'].includes(options.segment) ? [] : dates(start, season.end).slice(0, Number(options.days ?? dates(season.start,season.end).length))
  if(options.deferCalendarFailure)assert.ok(realPlan&&!options.resume&&selected.length<=2,'Calendar failure deferral is limited to a two-date diagnostic and remains fatal')
  let deferredCalendarError
  const { games } = JSON.parse(await readFile(path.join(fixtureDirectory, 'games.json'), 'utf8'))
  const store = await fixtureStore(fixtureDirectory)
  const auctionDate = start
  let runtime, context, baseline, probe, previous = {}, previousTeams = {}, observed = {}, activeDate
  let clock = options.resume?.clock ?? Date.parse(`${auctionDate}T09:59:00Z`)
  const verifiedWeeks = options.resume?.verifiedWeeks ?? []
  const report = { startedAt: new Date().toISOString(), phase: 'startup', complete: false, fullAcceptance: false, fresh: !options.resume, continuation: !!options.resume, interruptions: options.interruptions ?? [],
    dates: selected, days: [], events: {}, faults: [], actions: { provenance: 'SYNTHETIC', completed: [] },
    cadenceDays: {}, snapshots: [], liveSamples: 0, sampling: 'Authenticated matchups read before every internal get_live_poll_work call with a live-holder header, after each live worker, and after every live gate. This includes each internal tick and extra scoreboard refresh reads. Stored stat rows and locked starters form the independent oracle.',
    triggerFidelity: { verified: false, cadence: 'Every intervening UTC minute, plus worker timer deadlines; clock stays paused during I/O; no scoring/stat maintenance overrides', counts: {}, unsupportedInputs: [] },
    requestedSecondDates: realPlan&&(['post-draft','next-season-start','real-second-season'].includes(options.segment)||selected.at(-1)===season.end)?dates(realPlan.seasons[1].start,options.secondSeasonThrough??realPlan.seasons[1].end).length:0, inputPostponements:realPlan?.postponements.timelines??[], historicalRange: { start: season.start, end: season.end, dates: dates(season.start,season.end).length }, realTwoSeasons: !!realPlan, inputPlan: realPlan ? { provenance: realPlan.provenance, gaps: realPlan.gaps, postponementGaps: realPlan.postponements.gaps, draft: { availableAt: realPlan.draft.availableAt, availabilityProvenance: realPlan.draft.availabilityProvenance } } : null, acceptanceGaps: [], ancillaryGaps: ['Rankings and projections use incomplete fixture inputs. They do not determine the asserted locked-starter scores, waiver rules, playoff rules, draft order, or pick ownership. Projection quality and optimal lineup selection remain unverified.'] }
  if(realPlan) report.ancillaryGaps.push('This scenario starts a commissioner rookie draft; the automatic unstarted-draft backstop is not measured.')
  if (options.recoveryEvidence) Object.assign(report, options.recoveryEvidence)
  report.featureCheckpoints ??= []
  report.playersEvidence ??= []
  if(options.secondSeasonThrough)report.secondSeasonThrough=options.secondSeasonThrough
  const checkpoint = async phase => {
    report.phase = phase
    await writeJson(path.join(miniRoot, 'evidence/replay-checkpoint.json'), { ...report, savedAt: new Date().toISOString() })
    await writeJson(path.join(miniRoot, 'evidence/replay-progress.json'), { phase, completedDates: report.days.length, requestedDates: selected.length, fullAcceptance: report.fullAcceptance })
  }
  const sample = async (_at, jobs) => {
    if (!context || !jobs.some(job => job.jobname === 'nba-live-poll')) return
    const date = activeDate ?? etDate(new Date(clockTime(JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8')), Date.now())).toISOString())
    const activeGames = Number(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}' AND status='InProgress'`))
    if (!activeGames) return
    const week = await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear ?? season.year} AND '${date}' BETWEEN week_start AND week_end`)
    if (!week) return
    if (await isSkippedWeek(context, Number(week))) {
      await assertSkippedWeek(context, Number(week))
      await probe?.syncAuth()
      report.skippedLiveSamples = (report.skippedLiveSamples ?? 0) + 1
      return
    }
    const rows = Number(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${context.leagueSeasonId}' AND NOT is_voided AND ${Number(week)} BETWEEN week_number AND coalesce(end_week_number,week_number)`))
    if (!rows) {
      const playoffStart = Number(await sql(`SELECT playoff_start_week FROM leagues WHERE id='${context.leagueId}'`))
      assert.ok(Number(week) >= playoffStart, 'Regular week requires matchup rows')
      return
    }
    const result = await assertClientScores(context, { week: Number(week), previous: observed })
    observed = { ...observed, ...result.observations }
    await probe?.syncAuth()
    report.liveSamples++
    report.sourceCorrections ??= []
    report.sourceCorrections.push(...result.corrections)
  }
  const dispatcher = cronDispatcher(async outcome => {
    if (outcome.status_code === 200 && outcome.worker_status === 'success') return
    const at = Number(await sql('SELECT extract(epoch FROM now())*1000'))
    if (waiverBoundaryDeferral(outcome, context, at)) {
      report.waiverBoundaryDeferrals ??= []
      report.waiverBoundaryDeferrals.push({ id: outcome.id, at: new Date(at).toISOString(), errors: JSON.parse(outcome.content).leagues.filter(row => row.error) })
      return
    }
    const sourceError=realPlan&&outcome.function_name==='sync-draft-order'?await sql(`SELECT coalesce(error,'') FROM sync_runs WHERE id=(SELECT sync_run_id FROM edge_invocations WHERE id=${Number(outcome.id)})`):''
    if (realPlan && draftSourceUnavailable(outcome.function_name,at,realPlan.draft.availableAt,sourceError)) {
      report.sourceUnavailable ??= []
      report.sourceUnavailable.push({ function: outcome.function_name, id: outcome.id, businessAt: new Date(at).toISOString(), reason: realPlan.draft.availabilityProvenance,error:sourceError })
      return
    }
    if (['sync-rankings', 'sync-projections'].includes(outcome.function_name)) report.triggerFidelity.unsupportedInputs.push({ function: outcome.function_name, id: outcome.id, status: outcome.status_code })
    else assert.fail(`Production dispatch fails: ${JSON.stringify(outcome)}`)
  })
  const move = async value => {
    const to = typeof value === 'number' ? value : Date.parse(value)
    assert.ok(to >= clock, 'Replay cannot rewind business time')
    await advanceCron({ from: clock, to, counts: report.triggerFidelity.counts,
      move: at => setClock({ at: new Date(at).toISOString(), rate: 0, quiet: true }),
      invoke: dispatcher.enqueue, settle: dispatcher.settle, sample,
      profile: step => {
        const date = etDate(step.at)
        const row = report.cadenceDays[date] ??= { minutes: 0, steps: 0, wallSeconds: 0 }
        row.minutes += Number(step.minute)
        row.steps++
        row.wallSeconds += step.wallSeconds
      } })
    clock = to
  }
  const snapshot = async (name, date, days) => {
    if (options.resume && name === options.segment) return
    const preparation = await waitForSnapshotWorkers({ advance: move })
    runtime.origin.flushCoverage()
    const cursor = { date, clock, verifiedWeeks, actions: report.actions, evidence: { offseasonTrade: report.offseasonTrade }, context: Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value !== 'function')), options: { start: date, days } }
    if (name === 'post-draft' || realPlan && (name === 'next-season-start' || name.startsWith('real-second-'))) {
      cursor.stage = name.startsWith('real-second-') ? 'real-second-season' : name
      cursor.guard = await sql(postDraftStateQuery())
      cursor.evidence = Object.fromEntries((cursor.stage==='real-second-season'?realSecondRecoveryFields:name==='post-draft'?draftRecoveryFields:openingRecoveryFields).map(key => [key, report[key]]))
    }
    report.snapshots.push({ ...await saveSnapshot(name, cursor), preparation })
  }
  const liveCoverage = () => { runtime.origin.flushCoverage(); return runtime.origin.coverage }
  try {
    process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
    process.env.SEASON_SIM_DISCRETE_CLOCK = '1'
    const databaseBefore = JSON.parse(await sql("SELECT json_build_object('leagues',(SELECT count(*) FROM leagues),'stats',(SELECT count(*) FROM player_game_stats),'games',(SELECT count(*) FROM nba_games),'players',(SELECT count(*) FROM players),'authUsers',(SELECT count(*) FROM auth.users))"))
    report.databaseBefore = databaseBefore
    report.freshDatabase = Object.values(databaseBefore).every(value => value === 0)
    if (!options.resume && start === season.start) assert.ok(report.freshDatabase, 'A full replay must start from an empty application database')
    report.source = await sourceEvidence()
    await writeJson(path.join(miniRoot, 'evidence/source-at-start.json'), report.source)
    runtime = await startRuntime(new Date(clock).toISOString(), { resume: !!options.resume })
    if (options.restoredDefinitions) assert.equal(await functionFingerprint(), options.restoredDefinitions, 'Runtime clock startup must preserve restored lane definitions')
    if (options.afterRestoreSql) report.overlay = await applyOverlay(options.afterRestoreSql)
    verifyCronCatalog(JSON.parse(await readFile(path.join(miniRoot, 'cron-jobs.json'), 'utf8')))
    report.triggerFidelity.catalog = 'cron-jobs.json; migrated rows and any previously captured rows'
    report.triggerFidelity.omittedJobs=JSON.parse(await readFile(path.join(miniRoot,'cron-jobs.json'),'utf8')).filter(row=>!productionJobs.some(job=>job.jobname===row.jobname)).map(row=>({...row,scope:'Ancillary housekeeping gap: inventory change hints, mock-room cleanup, response vacuum or retention. No mocks exist; two-season score/history oracles use primary tables. No claimed coverage for these jobs.'}))
    try { report.triggerFidelity.catalogEvidence = JSON.parse(await readFile(path.join(miniRoot, 'cron-catalog-evidence.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; report.triggerFidelity.catalogEvidence = { scope: 'Pinned stack catalog; capture metadata unavailable' } }
    await writeJson(path.join(miniRoot, 'state/fault.json'), {})
    baseline = await resetLoad()
    if (options.resume) {
      context = { ...options.resume.context, ...actionClient(runtime.keys) }
      for (const user of context.users) user.expiresAt = 0
    }
    else {
      await move(`${auctionDate}T14:00:00Z`)
      if(profile){
        try{await assertPublishedCalendar(profile)}catch(error){
          if(!options.deferCalendarFailure)throw error
          deferredCalendarError=error
          report.calendarFindings=[{name:error.name,message:error.message,area:error.area,scope:'Deferred only until this two-date diagnostic finishes; not acceptable for a fresh run'}]
        }
      }
      context = await createLeagueActions(runtime.keys, start, 4, { integrated: true, auctionDate, move, skipPastWeeks: options['late-season'] === true, playoffStartWeek: profile?.playoffStart })
      context.seasonYear = season.year
      context.seasonEnd = season.end
      context.firstDate = start
    }
    runtime.origin.onLiveSample = async event => {
      await sample(null, [{ jobname: 'nba-live-poll' }])
      report.internalLiveSamples ??= {}
      report.internalLiveSamples[event.phase] = (report.internalLiveSamples[event.phase] ?? 0) + 1
    }
    report.leagueId = context.leagueId
    report.leagueSeasonId = context.leagueSeasonId
    if(realPlan&&!options.resume){
      report.pushRegistration=await registerPushOwners(context,runtime.keys)
      await captureSeasonFeatures(context,profile,'week-1',report)
      await capturePlayers(context,'opening-before-played',report)
    }
    report.diagnosticSkippedWeeks = context.diagnosticSkippedWeeks ?? null
    probe = await startRealtimeProbe(context, runtime.keys)
    if (options.resume?.actions) { report.actions = options.resume.actions; report.retainedActions = true }
    if (options.resume?.evidence) Object.assign(report, options.resume.evidence)
    if (report.recovery) {
      report.recovery.historyBefore = await sql(recoveryHistoryQuery(start))
      assert.equal(JSON.parse(report.recovery.historyBefore).games, report.recovery.retainedGames, 'Restored finals must match retained receipts')
      assert.equal(await sql("SELECT count(*) FROM edge_invocations WHERE worker_status IN ('pending','running')"), '0', 'Recovery cannot inherit unfinished workers')
    }
    if (['automatic-champion', 'pre-rollover', 'post-rollover', 'pre-draft', 'post-draft', 'next-season-start', 'real-second-season'].includes(options.segment)) {
      if (options.segment === 'post-draft') report.nextSeason = await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }, { afterRookieActivation: true })
      if (options.segment === 'automatic-champion') {
        report.seasonEnd = await finishSeason(context, move, report, checkpoint, { snapshot })
        activeDate = null
        report.nextSeason = realPlan ? await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }) : await runNextSeason(context, report.seasonEnd.oldSeason, move, report, snapshot, checkpoint, liveCoverage)
      }
      if (options.segment === 'pre-rollover') report.seasonEnd = await finishSeason(context, move, report, checkpoint, { stopAfterRollover: true })
      if (['post-rollover', 'pre-draft'].includes(options.segment)) {
        await assertWaiverRollover(context, context.previousSeasonId, report)
        report.seasonEnd = await finishRookieDraft(context, move, report, checkpoint, { snapshot })
        report.nextSeason = realPlan ? await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }) : await runNextSeason(context, report.seasonEnd.oldSeason, move, report, snapshot, checkpoint, liveCoverage)
      }
      if (options.segment === 'next-season-start') report.nextSeason = realPlan ? await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }, { afterOpening: true }) : await runNextSeason(context, context.previousSeasonId, move, report, snapshot, checkpoint, liveCoverage)
      if (options.segment === 'real-second-season') report.nextSeason = await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }, { afterOpening: true, startDate: start })
      await dispatcher.drain(clock)
      if (report.nextSeason?.passed && probe) {
        const delivery = await probe.verify(await context.rest(context.users[0], `matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`))
        if (realPlan) report.realtimeSecond = delivery
        else report.realtime = delivery
        await probe.close()
        probe = null
      }
      report.triggerFidelity.verified = true
      if (report.recovery) assert.equal(await sql(recoveryHistoryQuery(start)), report.recovery.historyBefore, 'Stage continuation preserves settled scoring history')
      report.complete = true
      report.acceptanceGaps = acceptanceGaps(report)
      return report
    }
    if (realPlan) report.firstCalendar = await assertTwoCalendar(context, profile,!!deferredCalendarError)
    const trades = tradeScenarios(context, report.actions, move)
    for (const date of selected) {
      activeDate = date
      const began = Date.now()
      const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
      const today = games.filter(game => game.date === date)
      const plan = await planDay(today, store, date, profile ? { profile, calendar: profile.calendar, postponements: realPlan.postponements.timelines, playoffStart: profile.playoffStart } : undefined)
      const day = { date, category: plan.category, plannedCheckpoints: plan.events.length, minimumSnapshots: plan.minimumSnapshots, requiredPeriods: plan.requiredPeriods }
      await checkpoint(`${date}:morning`)
      await move(Math.max(Date.parse(`${date}T14:00:00Z`), clock))
      const teams = await assertHistoricalTeams(runtime.origin.historicalRoster(), previousTeams)
      previousTeams = teams.teams
      day.nbaTeams = { checked: teams.checked, changes: teams.changes }
      await verifyWaivers(context, report)
      if (!options.resume && date === start) await beginWaivers(context, 'season-one-faab', report)
      if (date === season.end) await beginWaivers(context, 'postseason-pending', report)
      if (realPlan) { await nbaTradeSetup(context,date,realPlan); await allStarLimit(context,date,profile,report) }
      await prepareLineups(context, date, day)
      if(realPlan&&day.lineups.week)await rookieLineups(context,date,day.lineups.week,today,store,report)
      if (date === shiftDay(season.start,6) || options['late-season'] && date === start) await snapshot('live-week', date, 1)
      if (date === start && !options.resume) await snapshot('waiver-week', date, 5)
      if (date === `${season.year}-01-14`) await snapshot('pre-deadline', date, 3)
      if (date === (profile?.calendar.weeks.find(row=>row.week_number===profile.playoffStart)?.week_start ?? shiftDay(season.end,-20))) await snapshot('pre-playoffs', date, 4)
      await trades(date)
      for (const event of plan.events) {
        await checkpoint(`${date}:${event.type}:${new Date(event.at).toISOString()}`)
        await move(event.at)
        await checkLineups(context, date, day)
        report.events[event.type] = (report.events[event.type] ?? 0) + 1
      }
      await checkpoint(`${date}:recheck`)
      await move(`${next}T09:00:00Z`)
      day.finals = today.length ? await assertFinals(date) : { date, games: 0, reason: 'No historical NBA games' }
      day.points = today.length ? await assertLeaguePoints({ ...context, date, plannedEmptyWeek: 2 }) : null
      day.live = today.length ? await assertClientScores(context, { previous: observed }) : null
      if (day.live) observed = { ...observed, ...day.live.observations }
      await verifyWaivers(context, report)
      day.weekly = await assertClosedWeeks(context, next, verifiedWeeks)
      day.coverage = assertLiveCoverage(runtime.origin.coverage, today, plan)
      if(realPlan&&!report.featureCheckpoints.some(row=>row.year===context.seasonYear&&row.label==='mid-season')&&profile.calendar.weeks.find(row=>row.week_start<=date&&row.week_end>=date)?.week_number>=Math.floor(profile.playoffStart/2))await captureSeasonFeatures(context,profile,'mid-season',report)
      if(realPlan&&!report.playersEvidence.some(row=>row.year===context.seasonYear&&row.label==='after-first-final'))await capturePlayers(context,'after-first-final',report)
      day.domain = await assertDomain(context, previous)
      previous = day.domain
      day.wallSeconds = (Date.now() - began) / 1000
      report.days.push(day)
      if (!report.realtime && probe.events.some(event => event.scoreChanged)) {
        report.realtime = await probe.verify(await context.rest(context.users[0], `matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`))
        await probe.close()
        probe = null
      }
      if (realPlan) day.realInputs = await assertTwoDay(context,date,report,realPlan,store,today)
      runtime.origin.flushCoverage()
      console.log(JSON.stringify({ date, games: day.finals.games, wallSeconds: day.wallSeconds, liveSamples: report.liveSamples }))
      await checkpoint(`${date}:verified`)
      if (report.recovery) {
        assert.equal(await sql(recoveryHistoryQuery(start)), report.recovery.historyBefore, 'Continuation preserves settled scoring history')
        if (next <= season.end) await snapshot(`recovery-${next}`, next, dates(next, season.end).length)
      }
    }
    const current = await context.rest(context.users[0], `matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`)
    if (!report.realtime) report.realtime = await probe.verify(current)
    if(deferredCalendarError)throw deferredCalendarError
    if (selected.at(-1) === season.end) {
      report.seasonEnd = await finishSeason(context, move, report, checkpoint, { snapshot })
      activeDate = null
      report.nextSeason = realPlan ? await runRealSeason(context,realPlan,move,report,checkpoint,snapshot,liveCoverage,async()=>{ await probe?.close(); probe=await startRealtimeProbe(context,runtime.keys) }) : await runNextSeason(context, report.seasonEnd.oldSeason, move, report, snapshot, checkpoint, liveCoverage)
    }
    await dispatcher.drain(clock)
    if (realPlan && report.nextSeason?.passed) report.realtimeSecond=await probe.verify(await context.rest(context.users[0],`matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`))
    report.complete = true
    report.triggerFidelity.verified = true
    report.acceptanceGaps = acceptanceGaps(report)
    report.fullAcceptance = start === season.start && selected.length === dates(season.start,season.end).length && report.acceptanceGaps.length === 0 && report.seasonEnd?.passed === true && report.triggerFidelity.verified
    await checkpoint('requested-days-verified')
  } catch (error) {
    report.failure = { name: error.name, message: error.message, stack: error.stack, area: error.area ?? (/rookie/i.test(error.message)?'rookie-identity':null) }
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    report.wallSeconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000
    report.segments = [{ name: options.segment ?? 'replay', startedAt: report.startedAt, finishedAt: report.finishedAt, seconds: report.wallSeconds, restoredSnapshot: options.segment ?? null }]
    await checkpoint(report.phase)
    await probe?.close()
    if (runtime) {
      try { await captureLoad('replay', baseline) } finally { await runtime.close() }
    }
  }
  return report
}
