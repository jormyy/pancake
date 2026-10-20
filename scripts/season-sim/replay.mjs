import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { assertFinals, assertLeaguePoints, captureLoad, resetLoad } from './assertions.mjs'
import { assertDomain, assertLiveCoverage, assertHistoricalTeams } from './invariants.mjs'
import { actionClient, createLeagueActions } from './actions.mjs'
import { prepareLineups, checkLineups } from './lineups.mjs'
import { startRuntime } from './runtime.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { dates, miniRoot, season, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { clockTime } from './virtual-clock.mjs'
import { planDay } from './planner.mjs'
import { finishSeason, finishRookieDraft } from './season-end.mjs'
import { advanceCron, verifyCronCatalog } from './cron.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { startRealtimeProbe } from './realtime-probe.mjs'
import { saveSnapshot } from './checkpoints.mjs'
import { runNextSeason } from './next-season.mjs'
import { tradeScenarios } from './trade-scenarios.mjs'

export async function replay(options = {}) {
  const start = options.resume?.date ?? options.start ?? (options['late-season'] ? '2026-03-16' : season.start)
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(options.segment === 'next-season-start' || start >= season.start && start <= season.end)
  const selected = dates(start, season.end).slice(0, Number(options.days ?? 174))
  const { games } = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/games.json'), 'utf8'))
  const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
  const auctionDate = start
  let runtime, context, baseline, probe, previous = {}, previousTeams = {}, observed = {}, activeDate
  let clock = options.resume?.clock ?? Date.parse(`${auctionDate}T09:59:00Z`)
  const verifiedWeeks = options.resume?.verifiedWeeks ?? []
  const report = { startedAt: new Date().toISOString(), phase: 'startup', complete: false, fullAcceptance: false, fresh: !options.resume, continuation: !!options.resume,
    dates: selected, days: [], events: {}, faults: [], actions: { provenance: 'SYNTHETIC', completed: [] },
    snapshots: [], liveSamples: 0, sampling: 'Authenticated matchups read after every production live-poll gate tick while NBA games are in progress, on every date. Stored stat rows and locked starters form the independent oracle.',
    triggerFidelity: { verified: false, cadence: 'Every intervening UTC minute; no scoring/stat maintenance overrides', counts: {}, unsupportedInputs: [] },
    acceptanceGaps: ['Restored segment proofs remain required', 'A fresh committed-source replay remains required', 'Sampling every internal live-poll worker tick remains required', 'Ancillary cron jobs and ranking/projection sources remain required'] }
  const checkpoint = async phase => {
    report.phase = phase
    await writeJson(path.join(miniRoot, 'evidence/replay-checkpoint.json'), { ...report, savedAt: new Date().toISOString() })
    await writeJson(path.join(miniRoot, 'evidence/replay-progress.json'), { phase, completedDates: report.days.length, requestedDates: selected.length, fullAcceptance: report.fullAcceptance })
  }
  const sample = async (_at, jobs) => {
    if (!context || !activeDate || !jobs.some(job => job.jobname === 'nba-live-poll')) return
    const activeGames = Number(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${activeDate}' AND status='InProgress'`))
    if (!activeGames) return
    const week = await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear ?? 2026} AND '${activeDate}' BETWEEN week_start AND week_end`)
    if (!week) return
    const rows = Number(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${context.leagueSeasonId}' AND NOT is_voided AND ${Number(week)} BETWEEN week_number AND coalesce(end_week_number,week_number)`))
    if (!rows) {
      const playoffStart = Number(await sql(`SELECT playoff_start_week FROM leagues WHERE id='${context.leagueId}'`))
      assert.ok(Number(week) >= playoffStart, 'Regular week requires matchup rows')
      return
    }
    const result = await assertClientScores(context, { week: Number(week), previous: observed })
    observed = { ...observed, ...result.observations }
    report.liveSamples++
    report.sourceCorrections ??= []
    report.sourceCorrections.push(...result.corrections)
  }
  const move = async value => {
    const to = typeof value === 'number' ? value : Date.parse(value)
    assert.ok(to >= clock, 'Replay cannot rewind business time')
    await advanceCron({ from: clock, to, counts: report.triggerFidelity.counts,
      move: (at, capAt) => setClock({ at: new Date(at).toISOString(), rate: at < capAt ? 100 : 0, capAt: new Date(capAt).toISOString() }),
      invoke: async (statement, flags) => {
        const outcomes = await dispatch(statement, { ...flags, allowFailure: true })
        for (const outcome of outcomes) {
          if (outcome.status_code === 200 && outcome.worker_status === 'success') continue
          if (['sync-rankings', 'sync-projections'].includes(outcome.function_name)) report.triggerFidelity.unsupportedInputs.push({ function: outcome.function_name, id: outcome.id, status: outcome.status_code })
          else assert.fail(`Production dispatch fails: ${JSON.stringify(outcome)}`)
        }
      }, sample })
    clock = to
  }
  const snapshot = async (name, date, days) => {
    if (options.resume) return
    runtime.origin.flushCoverage()
    const cursor = { date, clock, verifiedWeeks, actions: report.actions, evidence: { offseasonTrade: report.offseasonTrade }, context: Object.fromEntries(Object.entries(context).filter(([, value]) => typeof value !== 'function')), options: { start: date, days } }
    report.snapshots.push(await saveSnapshot(name, cursor))
  }
  try {
    process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
    runtime = await startRuntime(new Date(clock).toISOString(), { resume: !!options.resume })
    verifyCronCatalog(JSON.parse(await readFile(path.join(miniRoot, 'cron-jobs.json'), 'utf8')))
    report.triggerFidelity.catalog = 'cron-jobs.json; captured from this stack after all migrations'
    await writeJson(path.join(miniRoot, 'state/fault.json'), {})
    baseline = await resetLoad()
    if (options.resume) {
      context = { ...options.resume.context, ...actionClient(runtime.keys) }
      for (const user of context.users) user.expiresAt = 0
    }
    else {
      await move(`${auctionDate}T14:00:00Z`)
      context = await createLeagueActions(runtime.keys, start, 4, { integrated: true, auctionDate, move })
      context.seasonYear = 2026
      context.firstDate = start
    }
    report.leagueId = context.leagueId
    report.leagueSeasonId = context.leagueSeasonId
    probe = await startRealtimeProbe(context, runtime.keys)
    if (options.resume?.actions) report.actions = options.resume.actions
    if (options.resume?.evidence) Object.assign(report, options.resume.evidence)
    if (['pre-rollover', 'pre-draft', 'next-season-start'].includes(options.segment)) {
      if (options.segment === 'pre-rollover') report.seasonEnd = await finishSeason(context, move, report, checkpoint, { stopAfterRollover: true })
      if (options.segment === 'pre-draft') report.seasonEnd = await finishRookieDraft(context, move, report, checkpoint)
      if (options.segment === 'next-season-start') report.nextSeason = await runNextSeason(context, context.previousSeasonId, move, report, snapshot)
      report.complete = true
      return report
    }
    const trades = tradeScenarios(context, report.actions, move)
    for (const date of selected) {
      activeDate = date
      const began = Date.now()
      const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
      const today = games.filter(game => game.date === date)
      const plan = await planDay(today, store, date)
      const day = { date, category: plan.category, plannedCheckpoints: plan.events.length, minimumSnapshots: plan.minimumSnapshots, requiredPeriods: plan.requiredPeriods }
      await checkpoint(`${date}:morning`)
      await move(Math.max(Date.parse(`${date}T14:00:00Z`), clock))
      const teams = await assertHistoricalTeams(runtime.origin.historicalRoster(), previousTeams)
      previousTeams = teams.teams
      day.nbaTeams = { checked: teams.checked, changes: teams.changes }
      await prepareLineups(context, date, day)
      if (date === '2025-10-27' || options['late-season'] && date === start) await snapshot('live-week', date, 1)
      if (date === '2026-01-14') await snapshot('pre-deadline', date, 3)
      if (date === '2026-03-23') await snapshot('pre-playoffs', date, 4)
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
      day.weekly = await assertClosedWeeks(context, next, verifiedWeeks)
      day.coverage = assertLiveCoverage(runtime.origin.coverage, today, plan)
      day.domain = await assertDomain(context, previous)
      previous = day.domain
      day.wallSeconds = (Date.now() - began) / 1000
      report.days.push(day)
      runtime.origin.flushCoverage()
      console.log(JSON.stringify({ date, games: day.finals.games, wallSeconds: day.wallSeconds, liveSamples: report.liveSamples }))
      await checkpoint(`${date}:verified`)
    }
    const current = await context.rest(context.users[0], `matchups?select=*&league_season_id=eq.${context.leagueSeasonId}`)
    report.realtime = await probe.verify(current)
    if (selected.at(-1) === season.end) {
      report.seasonEnd = await finishSeason(context, move, report, checkpoint, { snapshot })
      activeDate = null
      report.nextSeason = await runNextSeason(context, report.seasonEnd.oldSeason, move, report, snapshot)
    }
    report.complete = true
    report.triggerFidelity.verified = report.triggerFidelity.unsupportedInputs.length === 0
    report.fullAcceptance = start === season.start && selected.length === 174 && report.acceptanceGaps.length === 0 && report.seasonEnd?.passed === true && report.triggerFidelity.verified
    await checkpoint('requested-days-verified')
  } catch (error) {
    report.failure = { name: error.name, message: error.message, stack: error.stack }
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
}

export async function retainedClock() {
  return clockTime(JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8')), Date.now())
}
