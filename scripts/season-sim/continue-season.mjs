import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { startRuntime } from './runtime.mjs'
import { resumeLeagueActions } from './actions.mjs'
import { finishSeason } from './season-end.mjs'
import { setClock } from './clock.mjs'
import { assertFinals, assertLeaguePoints, captureLoad } from './assertions.mjs'

const evidence = path.join(miniRoot, 'evidence')
const report = JSON.parse(await readFile(path.join(evidence, 'replay-checkpoint.json'), 'utf8'))
assert.equal(report.complete, false)
assert.equal(report.days.length, 174)
assert.equal(report.days.reduce((sum, day) => sum + day.finals.games, 0), 1230)
assert.equal(report.events.finalDateReruns, 174)
assert.match(report.phase, /playoff-grace/)
assert.match(report.failure?.message ?? '', /Resolve pending waiver claims and waiver holds/)
const at = await sql('SELECT now()')
const start = Date.parse(at)
assert.ok(Number.isFinite(start))
const retainedContext = JSON.parse(await readFile(path.join(miniRoot, 'state/league.json'), 'utf8'))
assert.equal(retainedContext.leagueId, report.leagueId)
assert.equal(retainedContext.leagueSeasonId, report.leagueSeasonId)
assert.match(report.leagueId, /^[a-f0-9-]{36}$/)
assert.equal(await sql(`SELECT id FROM league_seasons WHERE league_id='${report.leagueId}' AND is_current`), report.leagueSeasonId)
const before = await sqlJson(`SELECT json_build_object('claims',(SELECT count(*) FROM waiver_claims WHERE status='pending'), 'holds',(SELECT count(*) FROM waiver_wire_log WHERE cleared_at IS NULL), 'statsHash',(SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s))`, 'continuation baseline')
const baseline = await sqlJson('SELECT json_agg(t) FROM (SELECT schemaname,relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables) t', 'continuation table counters')
report.interruptions = [{ phase: report.phase, failure: report.failure, finishedAt: report.finishedAt, simulatedAt: new Date(start).toISOString(), classification: 'SIM-H012: driver omitted daily waiver dispatch after October 25; backend unchanged' }]
report.segments = [{ startedAt: report.startedAt, finishedAt: report.finishedAt, wallSeconds: report.wallSeconds, kind: 'regular season and first grace attempt' }]
const segment = { startedAt: new Date().toISOString(), finishedAt: '', wallSeconds: 0, kind: 'same DB; driver-only boundary continuation and full final audit' }
report.segments.push(segment)
await writeJson(path.join(evidence, 'continuation-baseline.json'), { at, ...before, tableCounters: baseline, originalRun: report.segments[0] })
const checkpoint = async phase => {
  report.phase = phase
  await writeJson(path.join(evidence, 'replay-checkpoint.json'), { ...report, savedAt: new Date().toISOString() })
}
let runtime
try {
  runtime = await startRuntime(new Date(start).toISOString(), { resume: true })
  retainedContext.members = await sqlJson(`SELECT json_agg(m ORDER BY (m.role='commissioner') DESC,m.id) FROM (SELECT id,user_id,role FROM league_members WHERE league_id='${report.leagueId}') m`, 'continuation members')
  const context = await resumeLeagueActions(runtime.keys, retainedContext)
  const move = async instant => {
    const previous = Number(await sql('SELECT extract(epoch FROM now())*1000'))
    assert.ok(Date.parse(instant) >= previous, 'Continuation cannot rewind the simulated clock')
    await setClock({ at: instant, rate: 0 })
    report.clockMoves++
  }
  report.seasonEnd = await finishSeason(context, move, report, checkpoint, { continuation: true })
  assert.equal(await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`), before.statsHash)
  report.continuationWaivers = await sqlJson(`SELECT json_build_object('claims',(SELECT count(*) FROM waiver_claims WHERE status='pending'), 'holds',(SELECT count(*) FROM waiver_wire_log WHERE cleared_at IS NULL), 'cleared',(SELECT json_agg(w) FROM waiver_wire_log w WHERE cleared_at >= '${new Date(start).toISOString()}'))`, 'continuation waiver recovery')
  assert.equal(report.continuationWaivers.claims, 0)
  assert.equal(report.continuationWaivers.holds, 0)
  report.finalAudit = []
  for (const day of report.days.filter(day => day.finals.games > 0)) {
    await checkpoint(`${day.date}:whole-season-final-audit`)
    const finals = await assertFinals(day.date)
    const points = await assertLeaguePoints({ ...context, leagueSeasonId: report.leagueSeasonId, date: day.date, allowEmptyLineups: true })
    report.finalAudit.push({ date: day.date, finals, points })
  }
  assert.equal(report.finalAudit.reduce((sum, day) => sum + day.finals.games, 0), 1230)
  report.complete = true
  report.fullAcceptance = report.actions.passed && report.seasonEnd.passed
  delete report.failure
  await checkpoint('requested-days-verified')
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }
  throw error
} finally {
  report.finishedAt = segment.finishedAt = new Date().toISOString()
  segment.wallSeconds = (Date.parse(segment.finishedAt) - Date.parse(segment.startedAt)) / 1000
  report.wallSeconds = report.segments.reduce((sum, part) => sum + part.wallSeconds, 0)
  report.elapsedIncludingPauseSeconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000
  await checkpoint(report.phase)
  try { await captureLoad('continuation', baseline) } finally { if (runtime) await runtime.close() }
}
