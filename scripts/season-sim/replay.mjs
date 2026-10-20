import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { assertFinals, assertLeaguePoints, captureLoad, resetLoad } from './assertions.mjs'
import { assertDomain, assertLiveCoverage, assertHistoricalTeams } from './invariants.mjs'
import { createLeagueActions } from './actions.mjs'
import { actionPhases } from './action-phases.mjs'
import { prepareLineups, checkLineups, handleIrReturn } from './lineups.mjs'
import { probeOutOfOrder, probeRecovery } from './faults.mjs'
import { morningFault, finalOutage } from './timeline-faults.mjs'
import { startRuntime } from './runtime.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { dates, miniRoot, season, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { clockTime } from './virtual-clock.mjs'
import { planDay, canOverlapDispatch } from './planner.mjs'
import { postponementCases, assertPostponements } from './postponements.mjs'
import { finishSeason } from './season-end.mjs'
import { maintenanceTick } from './maintenance.mjs'

export async function replay(options = {}) {
  const start = options.start ?? season.start
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(start >= season.start && start <= season.end)
  const selected = dates(start, season.end).slice(0, Number(options.days ?? 174))
  const { games } = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/games.json'), 'utf8'))
  const postponed = postponementCases(JSON.parse(await readFile(path.join(miniRoot, 'fixtures/schedule.json'), 'utf8')).games, games)
  const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
  const integrated = start === season.start
  const auctionDate = new Date(Date.parse(`${start}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
  let runtime, context, baseline, phaseIterator, phase, previous = {}, previousTeams = {}
  const report = { startedAt: new Date().toISOString(), phase: 'startup', complete: false, fullAcceptance: false, seed: 493, dates: selected, days: [], events: {}, faults: [], actions: { provenance: 'SYNTHETIC', completed: [], passed: false }, clockMoves: 0 }
  const checkpoint = async phaseName => {
    report.phase = phaseName
    await writeJson(path.join(miniRoot, 'evidence/replay-checkpoint.json'), { ...report, savedAt: new Date().toISOString() })
    await writeFile(path.join(miniRoot, 'evidence/replay-progress.md'), `Replay phase: ${phaseName}\nCompleted dates: ${report.days.length}/${selected.length}\nLast completed date: ${report.days.at(-1)?.date ?? 'none'}\nFull acceptance: ${report.fullAcceptance}\n`)
  }
  const currentTime = async () => clockTime(JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8')), Date.now() + 500)
  const move = async (at, rate = 0, capAt) => {
    const requested = typeof at === 'number' ? at : Date.parse(at)
    const before = await currentTime()
    const instant = Math.max(requested, before)
    if (instant > requested) report.delayedClockMoves = (report.delayedClockMoves ?? 0) + 1
    await setClock({ at: new Date(instant).toISOString(), rate, capAt: capAt == null ? undefined : new Date(capAt).toISOString() })
    report.clockMoves++
  }
  for (const file of ['upstream-events.jsonl', 'edge-invocations.jsonl', 'user-actions.jsonl', 'dispatch.jsonl', 'edge.log']) {
    try { await rename(path.join(miniRoot, 'evidence', file), path.join(miniRoot, 'evidence', `${file}.previous`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  try {
    runtime = await startRuntime(`${auctionDate}T12:10:00Z`)
    await writeJson(path.join(miniRoot, 'state/fault.json'), {})
    baseline = await resetLoad()
    await move(`${auctionDate}T14:00:00Z`)
    await dispatch("SELECT public.invoke_edge_function_at_et_time('sync-schedule',6,5)")
    await dispatch("SELECT public.invoke_edge_function_at_et_time('sync-players',6,0)")
    context = await createLeagueActions(runtime.keys, start, integrated ? 4 : 2, { integrated, auctionDate })
    report.leagueId = context.leagueId
    report.leagueSeasonId = context.leagueSeasonId
    if (integrated) phaseIterator = actionPhases(context, report.actions)
    for (const date of selected) {
      const began = Date.now()
      const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
      const today = games.filter(game => game.date === date)
      const plan = await planDay(today, store, date)
      const day = { date, category: plan.category, plannedCheckpoints: plan.events.length, minimumSnapshots: plan.minimumSnapshots, requiredPeriods: plan.requiredPeriods }
      await checkpoint(`${date}:morning`)
      await move(Math.max(Date.parse(`${date}T14:00:00Z`), await currentTime()))
      await sql('SELECT private.reconcile_edge_invocations()')
      await dispatch("SELECT public.invoke_edge_function_at_et_time('sync-schedule',6,5)")
      assert.equal(Number(await sql('SELECT count(*) FROM nba_games')), 1230)
      await dispatch("SELECT public.invoke_edge_function_at_et_time('sync-players',6,0)")
      const teams = await assertHistoricalTeams(runtime.origin.historicalRoster(), previousTeams)
      previousTeams = teams.teams
      day.nbaTeams = { checked: teams.checked, changes: teams.changes }
      if (integrated) {
        const offset = Math.round((Date.parse(date) - Date.parse(start)) / 86400000)
        if (!phase || (!phase.done && (phase.value.date ? date >= phase.value.date : offset >= phase.value.day))) {
          await move(`${date}T15:00:00Z`)
          phase = await phaseIterator.next()
        }
        await morningFault(date, today, move, report)
      }
      await move(`${date}T15:00:00Z`)
      const maintenance = await maintenanceTick()
      assert.ok(maintenance.every(result => result.worker_status === 'success'), 'Daily maintenance must finish before gameplay')
      await move(`${date}T15:10:00Z`)
      await handleIrReturn(context, date, report.actions)
      await prepareLineups(context, date, day)
      let latest = await currentTime()
      for (const [index, event] of plan.events.entries()) {
        await checkpoint(`${date}:${event.type}:${new Date(event.at).toISOString()}`)
        const instant = Math.max(event.at, latest)
        if (event.type === 'pre-tipoff') assert.ok(instant < event.at + 60000, 'A live worker must not consume the pre-tip window')
        await move(instant, event.type === 'pre-tipoff' ? 0 : 20, event.type === 'pre-tipoff' ? undefined : plan.events[index + 1]?.at)
        if (event.type === 'pre-tipoff') await dispatch('SELECT public.invoke_pre_tipoff_optimizer_if_due()')
        else {
          const overlap = date === '2025-10-28' && event.type === 'live' && !report.events.overlap && canOverlapDispatch(event, plan.events[index + 1])
          if (integrated && date === '2025-11-04' && event.type === 'final') await finalOutage(date, instant, move, report)
          else await dispatch(overlap ? ['SELECT public.invoke_live_poll_if_due()', 'SELECT public.invoke_live_poll_if_due()'] : 'SELECT public.invoke_live_poll_if_due()', { optional: true })
          if (overlap) { report.events.overlap = 1; report.faults.push({ date, name: 'overlapping-cron-dispatch', provenance: 'SYNTHETIC', seed: 493 }) }
          await move(await currentTime(), 0)
          await checkLineups(context, date, day)
        }
        report.events[event.type] = (report.events[event.type] ?? 0) + 1
        if (date === '2025-10-22' && event.type === 'live' && event.at > Date.parse('2025-10-23T00:00:00Z') && !report.events.outOfOrder && (!plan.events[index + 1] || plan.events[index + 1].at - await currentTime() > 300000)) {
          const status = await sql("SELECT status FROM nba_games WHERE nba_game_id='0022500003'")
          if (status === 'InProgress') {
            await move(await currentTime(), 20, plan.events[index + 1]?.at)
            await probeOutOfOrder('0022500003', '2025-10-22T23:25:00Z')
            report.events.outOfOrder = 1
            report.faults.push({ date, name: 'out-of-order-scoreboard-and-box', provenance: 'SYNTHETIC', seed: 493 })
          }
        }
        await move(await currentTime(), 0)
        latest = await currentTime()
      }
      await checkpoint(`${date}:recheck`)
      await move(`${next}T09:00:00Z`)
      await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"${date}"}')`)
      await dispatch(`SELECT public.invoke_edge_function('sync-scores','{"date":"${date}T20:00:00Z"}')`)
      day.finals = today.length ? await assertFinals(date) : { date, games: 0, reason: 'No historical NBA games' }
      day.points = today.length ? await assertLeaguePoints({ ...context, date, allowEmptyLineups: true }) : null
      day.postponements = await assertPostponements(postponed, date)
      day.coverage = assertLiveCoverage(runtime.origin.coverage, today, plan)
      day.domain = await assertDomain(context, previous)
      previous = day.domain
      if (date === '2025-10-24' && integrated) {
        const recovery = await probeRecovery(runtime, date, today[0].id)
        report.faults.push(...recovery.cases.map(entry => ({ ...entry, date, provenance: 'SYNTHETIC', seed: 493 })))
      }
      day.wallSeconds = (Date.now() - began) / 1000
      report.days.push(day)
      runtime.origin.flushCoverage()
      console.log(JSON.stringify({ date, games: day.finals.games, wallSeconds: day.wallSeconds, category: plan.category, checks: day.domain.checks + day.coverage.checks }))
      await checkpoint(`${date}:verified`)
    }
    if (integrated && selected.at(-1) === season.end) report.seasonEnd = await finishSeason(context, move, report, checkpoint)
    report.complete = true
    report.fullAcceptance = integrated && selected.length === 174 && report.actions.passed && report.seasonEnd?.passed === true
    await checkpoint('requested-days-verified')
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    report.wallSeconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000
    await checkpoint(report.phase)
    if (runtime) {
      try { await captureLoad('replay', baseline) } finally { await runtime.close() }
    }
  }
}
