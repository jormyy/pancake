import assert from 'node:assert/strict'
import path from 'node:path'
import { writeJson, miniRoot } from './common.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'

export async function morningFault(date, games, move, report) {
  const file = path.join(miniRoot, 'state/fault.json')
  const record = async (name, outcomes) => {
    report.faults.push({ name, date, provenance: 'SYNTHETIC', seed: 493, outcomes })
    await writeJson(path.join(miniRoot, 'evidence/integrated-faults.json'), report.faults)
  }
  if (date === '2025-10-23') {
    await writeJson(file, { type: 'http', prefix: '/espn/', status: 503, provenance: 'SYNTHETIC', seed: 493 })
    try {
      const result = await dispatch("SELECT public.invoke_edge_function('sync-players')", { allowFailure: true })
      assert.ok(result.some(row => row.status_code !== 200))
      await record('espn-outage', result)
    } finally { await writeJson(file, {}) }
    await move(`${date}T14:10:00Z`, 0)
    await record('espn-recovery', await dispatch("SELECT public.invoke_edge_function('sync-players')"))
  }
  if (date === '2025-10-24') {
    const before = await sql('SELECT count(*) FROM nba_games')
    await writeJson(file, { type: 'missing-schedule', gameId: games[0].id, provenance: 'SYNTHETIC', seed: 493 })
    try {
      await record('missing-schedule-entry', await dispatch("SELECT public.invoke_edge_function('sync-schedule')", { allowFailure: true }))
      assert.equal(await sql('SELECT count(*) FROM nba_games'), before, 'A partial schedule cannot delete retained games')
    } finally { await writeJson(file, {}) }
    await record('missing-schedule-recovery', await dispatch("SELECT public.invoke_edge_function('sync-schedule')"))
  }
  if (date === '2025-11-04') {
    await writeJson(file, { type: 'http', prefix: '/', status: 503, provenance: 'SYNTHETIC', seed: 493 })
    try {
      for (const hour of [15, 17, 19]) {
        await move(`${date}T${hour}:00:00Z`, 30)
        const result = await dispatch("SELECT public.invoke_edge_function('sync-schedule'); SELECT public.invoke_edge_function('sync-players')", { allowFailure: true })
        assert.ok(result.some(row => row.status_code !== 200))
        await record('sustained-upstream-outage', result)
      }
    } finally { await writeJson(file, {}) }
    await move(`${date}T20:00:00Z`, 0)
    await record('sustained-outage-catch-up', await dispatch("SELECT public.invoke_edge_function('sync-schedule'); SELECT public.invoke_edge_function('sync-players')"))
  }
}

export async function finalOutage(date, at, move, report) {
  const file = path.join(miniRoot, 'state/fault.json')
  const pending = Number(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}' AND status<>'Final'`))
  assert.ok(pending > 0, 'The sustained outage must delay at least one real final')
  const rowsBefore = Number(await sql('SELECT count(*) FROM player_game_stats'))
  await writeJson(file, { type: 'http', prefix: '/', status: 503, provenance: 'SYNTHETIC', seed: 493 })
  try {
    for (const hours of [0, 2, 4]) {
      await move(at + hours * 3600000, 20)
      const live = await dispatch('SELECT public.invoke_live_poll_if_due()', { optional: true, allowFailure: true })
      const stats = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"${date}"}')`, { allowFailure: true })
      assert.ok(stats.some(row => row.status_code !== 200 || row.worker_status !== 'success'), 'The outage must expose unavailable final inputs')
      assert.equal(Number(await sql('SELECT count(*) FROM player_game_stats')), rowsBefore, 'An outage must preserve stored game rows')
      report.faults.push({ name: 'sustained-final-outage', date, simulatedAt: new Date(at + hours * 3600000).toISOString(), pendingFinals: pending, outcomes: [...live, ...stats], provenance: 'SYNTHETIC', seed: 493 })
    }
  } finally { await writeJson(file, {}) }
  await move(at + 6 * 3600000, 0)
  const outcomes = await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"${date}"}'); SELECT public.invoke_edge_function('sync-scores','{"date":"${date}T20:00:00Z"}')`)
  assert.equal(Number(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}' AND status<>'Final'`)), 0, 'Every delayed final must recover')
  report.faults.push({ name: 'sustained-final-catch-up', date, outageHours: 6, recoveredFinals: pending, outcomes, provenance: 'SYNTHETIC', seed: 493 })
  await writeJson(path.join(miniRoot, 'evidence/integrated-faults.json'), report.faults)
}
