import assert from 'node:assert/strict'
import path from 'node:path'
import { chmod, readFile } from 'node:fs/promises'
import { officialInputs } from './official-inputs.mjs'
import { officialRuntime } from './official-runtime.mjs'
import { createLeagueActions, actionClient } from './actions.mjs'
import { dates, etDate, laneDirectory, miniRoot, season, writeJson } from './common.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { assertFinals } from './assertions.mjs'
import { saveSnapshot, waitForSnapshotWorkers } from './checkpoints.mjs'
import { shiftDay } from './season-model.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { summarizeOfficial } from './official-report.mjs'
import { captureOfficialForecasts, scoreOfficialForecasts } from './official-forecast.mjs'
import { advanceOfficialTrades, auditOfficialTradeValues, recordPostTradeScoring } from './official-trades.mjs'
import { observeOfficialChampion, verifyOfficialRollover, runOfficialRookieDraft } from './official-lifecycle.mjs'
import { beginOfficialWaivers, verifyOfficialWaivers } from './official-waivers.mjs'
import { checkCalendar } from './calendar-oracle.mjs'

export async function officialReplay(options, scenario) {
  assert.ok(!options.afterRestoreSql, 'Official continuation requires unchanged application SQL; overlays use the generic diagnostic mode')
  const { profile } = scenario
  assert.equal(season.year, profile.firstYear, 'Official replay year must match the historical profile')
  assert.equal(process.env.SEASON_SIM_MODE, 'two-season', 'Official replay requires the retained two-season corpus')
  const input = await officialInputs(profile)
  const source = await sourceEvidence()
  if (options.resume?.evidence?.source) {
    assert.equal(source.harness.sha256, options.resume.evidence.source.harness.sha256, 'A historical replay cannot resume under changed checker code')
    assert.deepEqual(source.application, options.resume.evidence.source.application, 'A historical replay cannot resume under a changed application build')
  }
  assert.ok(!options.start || options.resume, 'A later official start requires a saved checkpoint')
  const start = options.resume?.date ?? input.bounds.firstStart
  const selected = dates(start, input.bounds.secondThrough).slice(0, options.days == null ? Infinity : Number(options.days))
  const report = { ...(options.resume?.evidence ?? {}), kind: 'official', source, complete: false, fullAcceptance: false, scenario, bounds: input.bounds,
    requestedDates: options.resume?.evidence?.requestedDates ?? selected.length, sourceFiles: input.files, inputGaps: input.gaps, postponementGaps: input.postponements?.gaps, draftAvailability: input.draft.availabilityProvenance, metadataLimits: input.metadataLimits, liveSamples: 0, startedAt: options.resume?.evidence?.startedAt ?? new Date().toISOString(), days: [...(options.resume?.evidence?.days ?? [])], snapshots: [...(options.resume?.evidence?.snapshots ?? [])],
    forecastHoldout: { calibration: [10, 13, 16], final: [17, 18, 19, 20, 21] },
    gaps: ['Forecast calibration receipts pending', 'Transaction scenario coverage pending', 'Automatic app update, browser, and performance evidence remain separate gates'],
  }
  const before = await sqlJson("SELECT json_build_object('leagues',(SELECT count(*) FROM leagues),'rosters',(SELECT count(*) FROM roster_players))", 'Official fresh database')
  report.freshDatabase = before.leagues === 0 && before.rosters === 0
  if (!options.resume) assert.ok(report.freshDatabase, 'Official replay requires an empty application database')
  let runtime, context, previous = options.resume?.previous ?? {}, checked = options.resume?.checked ?? []
  const sample = async (_at, jobs) => {
    if (!context || !jobs.some(job => job.jobname === 'nba-live-poll')) return
    const date = etDate(new Date(runtime.now()).toISOString())
    if (!Number(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}' AND status='InProgress'`))) return
    const week = Number(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear} AND '${date}' BETWEEN week_start AND week_end`))
    if (!week || profile.settings.skipped_weeks.includes(week)) return
    if (!Number(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${context.leagueSeasonId}' AND NOT is_voided AND ${week} BETWEEN week_number AND coalesce(end_week_number,week_number)`))) return
    const result = await assertClientScores(context, { week, previous })
    previous = { ...previous, ...result.observations }
    report.liveSamples++
  }
  try {
    runtime = await officialRuntime(options.resume?.at ?? `${start}T09:59:00Z`, report, input, sample, !!options.resume)
    if (options.resume) {
      assert.equal(options.resume.profileSha256, scenario.sha256, 'Checkpoint configuration must match')
      context = { ...options.resume.context, ...actionClient(runtime.keys) }
    } else {
      await runtime.move(`${start}T14:00:00Z`)
      context = await createLeagueActions(runtime.keys, start, profile.teamCount, { scenario: profile, move: runtime.move })
      if ('auction' in context) report.auction = context.auction
    }
    if ('auction' in context) report.auction ??= context.auction
    const preferences = await context.rest(context.users[0], `lineup_optimizer_settings?select=member_id,enabled&league_season_id=eq.${context.leagueSeasonId}`)
    assert.equal(preferences.length, profile.teamCount, 'Every official manager has an optimizer preference')
    assert.ok(preferences.every(row => row.enabled === true), 'All official managers start with their saved optimizer preference enabled')
    report.preferences = preferences
    runtime.origin.onLiveSample = () => sample(null, [{ jobname: 'nba-live-poll' }])
    await laneDirectory(path.join(miniRoot, 'state/eligibility'))
    const persistCursor = async date => {
      const file = path.join(miniRoot, 'state/official-cursor.json')
      await writeJson(file, { date, at: new Date(runtime.now()).toISOString(), context: serializableContext(context), profileSha256: scenario.sha256, previous, checked, evidence: report })
      await chmod(file, 0o600)
    }
    const firstContext = context
    await persistCursor(start)
    for (const date of selected) {
      const noon = Date.parse(`${date}T12:00:00Z`)
      if (noon > runtime.now()) await runtime.move(noon)
      const current = await sqlJson(`SELECT row_to_json(s) FROM league_seasons s WHERE league_id='${context.leagueId}' AND is_current`, 'Official current season')
      if (current.id !== context.leagueSeasonId) {
        const previousContext = context
        context = { ...context, leagueSeasonId: current.id, seasonYear: current.season_year, firstDate: input.seasons.find(row => row.year === current.season_year)?.start ?? date }
        await verifyOfficialRollover(context, previousContext, report, runtime.now())
        previous = {}; checked = []
      }
      if (date === input.bounds.checkpoint && !options.resume) {
        await waitForSnapshotWorkers({ advance: runtime.move })
        runtime.origin.flushCoverage()
        await runtime.verifyFidelity()
        report.snapshots.push(await saveSnapshot('pre-playoffs', { date, at: new Date(runtime.now()).toISOString(), context: serializableContext(context), profileSha256: scenario.sha256, previous, checked, evidence: structuredClone(report) }))
      }
      const day = { date, seasonYear: context.seasonYear }
      if (input.games.some(game => game.date === date)) {
        const file = path.join(miniRoot, 'state/eligibility', `${date}.json`)
        let saved
        try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!saved) {
          assert.ok(input.games.filter(game => game.date === date).every(game => Date.parse(game.time) > runtime.now()), 'Missing pregame eligibility cannot be reconstructed after tipoff')
          const players = await sqlJson("SELECT json_agg(p ORDER BY id) FROM (SELECT id,position,eligible_positions FROM players) p", 'Daily historical eligibility')
          saved = { date, observedAt: new Date(runtime.now()).toISOString(), players }
          await writeJson(file, saved)
        }
        day.eligibilityPlayers = saved.players.length
      }
      const calendar = input.seasons.find(row => row.year === context.seasonYear)?.calendar
      const week = calendar?.weeks.find(row => date >= row.week_start && date <= row.week_end)
      if (date === input.bounds.firstStart || date === input.bounds.secondStart) {
        const rows = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=${context.seasonYear}`, 'Official published calendar')
        const matchups = await context.rest(context.users[0], `matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`)
        day.calendar = checkCalendar(calendar, rows, matchups, context.users.map(user => user.memberId), profile.settings.skipped_weeks)
      }
      if (week && !profile.settings.skipped_weeks.includes(week.week_number)) await captureOfficialForecasts(context, date, week.week_number, report)
      if (week && context.seasonYear === profile.firstYear && [10, 13, 16, 17].includes(week.week_number)) await auditOfficialTradeValues(context, week.week_number, report)
      await advanceOfficialTrades(context, date, report, runtime.now())
      if (!report.waivers && context.seasonYear === profile.firstYear && date === calendar.weeks.find(row => !profile.settings.skipped_weeks.includes(row.week_number)).week_start) await beginOfficialWaivers(context, runtime.now(), report)
      await runtime.move(`${shiftDay(date, 1)}T09:59:00Z`)
      await verifyOfficialWaivers(context, report.waivers, runtime.now())
      if (input.games.some(game => game.date === date)) day.finals = await assertFinals(date)
      if (week && !profile.settings.skipped_weeks.includes(week.week_number)) {
        const count = Number(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${context.leagueSeasonId}' AND NOT is_voided AND ${week.week_number} BETWEEN week_number AND coalesce(end_week_number,week_number)`))
        const result = count ? await assertClientScores(context, { week: week.week_number, previous }) : null
        if (result) {
          previous = { ...previous, ...result.observations }
          day.scores = { passed: true, matchups: result.matchups.length }
          await recordPostTradeScoring(context, report, date)
        }
        day.closedWeeks = await assertClosedWeeks(context, date, checked)
        if (!report.corruptionControls && checked.length) report.corruptionControls = (await assertClientScores(context, { week: checked[0], corruptionControls: true })).controls
      }
      await scoreOfficialForecasts(context, report)
      await observeOfficialChampion(context, report, runtime.now())
      if (report.rollover && !report.rookieDraft && date >= input.draft.availableAt.slice(0, 10)) await runOfficialRookieDraft(context, input, report, runtime.move, runtime.now())
      day.state = await sqlJson(`SELECT json_build_object('seasons',(SELECT json_agg(s ORDER BY season_year) FROM league_seasons s WHERE league_id='${context.leagueId}'),'drafts',(SELECT coalesce(json_agg(d ORDER BY created_at),'[]') FROM drafts d WHERE league_id='${context.leagueId}'))`, 'Official lifecycle state')
      await runtime.verifyFidelity()
      report.days.push(day)
      await persistCursor(shiftDay(date, 1))
      await writeJson(path.join(miniRoot, 'evidence/official-replay.json'), report)
    }
    report.firstSeasonId = firstContext.leagueSeasonId
    report.complete = true
    report.fullRangeComplete = report.days.at(-1)?.date === input.bounds.secondThrough
    await runtime.verifyFidelity()
    const finalSource = await sourceEvidence()
    report.sourceMismatch = finalSource.harness.sha256 !== source.harness.sha256 || JSON.stringify(finalSource.application) !== JSON.stringify(source.application)
    report.acceptance = summarizeOfficial(report)
    report.fullAcceptance = report.acceptance.fullAcceptance
    report.gaps = report.acceptance.gaps
    return report
  } catch (error) {
    report.error = error.stack
    throw error
  } finally {
    let cleanupError
    try { await runtime?.close() } catch (error) { cleanupError = error; report.cleanupError = error.stack }
    report.finishedAt = new Date().toISOString()
    const summary = summarizeOfficial(report)
    report.fullAcceptance = summary.fullAcceptance
    await writeJson(path.join(miniRoot, 'evidence/official-replay.json'), report)
    await writeJson(path.join(miniRoot, 'evidence/official-summary.json'), summary)
    if (cleanupError) throw cleanupError
  }
}

function serializableContext(context) {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value !== 'function'))
}
