import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, fixtureDirectory, miniRoot } from '../season-sim/common.mjs'
import { sql, localKeys } from '../season-sim/local-stack.mjs'
import { replay } from '../season-sim/replay.mjs'
import { labRoot, project, json, requireMini, digest } from './common.mjs'
import { twoDayGates } from './gates.mjs'
import { execFileSync } from 'node:child_process'
import { harnessManifest } from '../season-sim/source-manifest.mjs'
import { measuredFetch } from './replay-capture.mjs'
import { retriesRecovered } from './retry-recovery.mjs'
import { waiverDiagnostics } from './waiver-diagnostics.mjs'
import { transferFaab } from './waiver-plan.mjs'
import { rosterInputCounts } from './roster-inputs.mjs'
import { fixtureStore } from '../season-sim/fixtures.mjs'

let deadline = Infinity

export function assertTwoDayDeadline() {
  assert.ok(Date.now() < deadline, 'Replay time budget reached before the two-day gates completed')
}

export async function counterTrade(context, report, move) {
  const [a, b] = context.users
  const faabAmount = 1
  await context.rpc(a, 'update_league_settings_atomic', { p_league_id: context.leagueId, p_settings: { trade_veto_mode: 'disabled' } })
  const pick = async member => sql(`SELECT id FROM draft_picks WHERE league_id='${context.leagueId}' AND current_owner_id='${member}' AND round=2 AND season_year=${context.seasonYear + 2} AND NOT is_used LIMIT 1`)
  const first = await pick(a.memberId), second = await pick(b.memberId)
  assert.ok(first && second, 'The two-day trade needs both teams’ picks')
  const proposed = await context.api(a, '/trades/propose', { memberId: a.memberId, leagueId: context.leagueId, leagueSeasonId: context.leagueSeasonId, recipientMemberId: b.memberId, offerPickIds: [first], requestPickIds: [second] })
  const countered = await context.api(b, `/trades/${proposed.tradeId}/counter`, { memberId: b.memberId, recipientMemberId: a.memberId, offerPickIds: [second], requestPickIds: [first], offerFaabAmount: faabAmount })
  await context.api(a, `/trades/${countered.tradeId}/accept`, { memberId: a.memberId })
  await move(Number(await sql('SELECT extract(epoch FROM now())*1000')) + 6 * 60000)
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${countered.tradeId}'`), 'completed')
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${first}'`), b.memberId)
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${second}'`), a.memberId)
  const before = context.expectedWaiverBudgets ?? Object.fromEntries(context.users.map(user => [user.memberId, 100]))
  context.expectedWaiverBudgets = transferFaab(before, b.memberId, a.memberId, faabAmount)
  report.twoDayTrade = { proposed: proposed.tradeId, countered: countered.tradeId, completed: true, faab: { from: b.memberId, to: a.memberId, amount: faabAmount, before, after: context.expectedWaiverBudgets } }
}

export async function captureForecasts(context, move) {
  const week = await sql(`SELECT week_number FROM season_weeks WHERE season_year=${context.seasonYear} AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN week_start AND week_end`)
  const matchups = await context.rest(context.users[0], `matchups?select=id&league_season_id=eq.${context.leagueSeasonId}&week_number=eq.${week}&is_voided=eq.false`)
  assert.ok(matchups.length, 'Forecasts need a real matchup')
  for (let attempt = 0; attempt < 10; attempt++) {
    const forecasts = await Promise.all(matchups.map(row => context.rpc(context.users[0], 'get_matchup_forecast', { p_matchup_id: row.id })))
    if (forecasts.every(row => row && Array.isArray(row.teams) && row.teams.length === 2)) return forecasts
    await move(Number(await sql('SELECT extract(epoch FROM now())*1000')) + 60000)
  }
  throw new Error('The production cadence did not publish matchup forecasts')
}

export async function runTwoDay(options = {}) {
  await requireMini()
  const seconds = Number(process.env.PERF_LAB_SECONDS ?? 0)
  deadline = seconds > 0 ? Date.now() + seconds * 1000 : Infinity
  assert.equal(config.project, project, 'The two-day flag requires the private performance lab')
  assert.equal(miniRoot, labRoot, 'The two-day flag requires the private lab directory')
  assert.equal(config.prefix, '572')
  assert.ok(!options.days || options.days === '2', 'Two-day mode runs exactly two days')
  const start = options.start ?? '2025-10-23'
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'scripts/season-sim', 'scripts/perf-lab', 'app', 'components', 'contexts', 'hooks', 'lib', 'supabase/functions', 'supabase/migrations'], { encoding: 'utf8' })
  assert.equal(dirty, '', 'The two-day replay requires committed source')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const archive = path.join(labRoot, 'integration.tar')
  execFileSync('git', ['archive', '--format=tar', '--output', archive, 'HEAD'])
  await json(path.join(labRoot, 'application-source.json'), { commit, archiveSha256: digest(await readFile(archive)), harnessSha256: (await harnessManifest()).sha256 })
  const end = new Date(Date.parse(`${start}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const file = path.join(fixtureDirectory, 'games.json')
  const source = JSON.parse(await readFile(file, 'utf8'))
  const boundary = new Date(Date.parse(`${start}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
  const games = source.games.filter(game => game.date <= end)
  assert.ok(games.some(game => game.date === boundary), 'The preceding day needs real inputs for overnight catch-up')
  assert.ok(games.some(game => game.date === start) && games.some(game => game.date === end), 'Both replay dates need complete real game inputs')
  const store = await fixtureStore(fixtureDirectory)
  const rosterInputs = { previous: await rosterInputCounts(games.filter(game => game.date >= boundary), store), retained: await rosterInputCounts(games, store), setupDate: boundary }
  await json(path.join(labRoot, 'evidence/roster-input-audit.json'), rosterInputs)
  assert.ok(rosterInputs.retained[boundary] >= 350, 'The setup day needs at least 350 dated roster observations')
  await writeFile(file, `${JSON.stringify({ ...source, games })}\n`)
  const keys = localKeys()
  process.env.SUPABASE_DB_URL = keys.DB_URL
  process.env.SUPABASE_URL = keys.API_URL
  const restored = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM (
    SELECT nba_game_id AS id, game_date::text AS date, game_time AS time, home_team AS home, away_team AS away
    FROM nba_games WHERE season_year=2026 AND nba_game_id LIKE '00225%' ORDER BY nba_game_id
  ) r`))
  const calendar = new Map(restored.filter(game => game.time).map(game => [game.id, game]))
  for (const game of games) {
    assert.ok(game.time && game.home && game.away, 'Every replayed game needs a real tipoff and both teams')
    calendar.set(game.id, game)
  }
  await json(path.join(fixtureDirectory, 'two-day-calendar.json'), { source: 'Restored calendar with the complete pinned two-day game window', games: [...calendar.values()], missingTimesOutsideWindow: restored.filter(game => !game.time).length })
  await json(path.join(labRoot, 'evidence/two-day-preparation.json'), { phase: 'remove-future-stats', startedAt: new Date().toISOString() })
  await sql(`BEGIN; SET LOCAL auto_explain.log_min_duration='-1'; SET LOCAL log_min_duration_statement='-1';
    DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year=2026 AND game_date>='${boundary}');
    UPDATE nba_games SET status='Scheduled',home_score=0,away_score=0 WHERE season_year=2026 AND game_date>='${boundary}';
    COMMIT;`)
  await json(path.join(labRoot, 'evidence/two-day-preparation.json'), { phase: 'prepared', finishedAt: new Date().toISOString() })
  const originalFetch = globalThis.fetch
  const measured = measuredFetch(originalFetch, path.join(labRoot, 'evidence/replay-client-access.jsonl'), waiverDiagnostics(path.join(labRoot, 'evidence/waiver-diagnostics.jsonl'), sql))
  globalThis.fetch = measured
  let report
  try { report = await replay({ start, days: 2, 'late-season': true, twoDay: true }) }
  finally { globalThis.fetch = originalFetch; await measured.flush() }
  const gates = { ...twoDayGates(report), retryRecovery: retriesRecovered(report) }
  const receipt = { captureProfile: process.env.PERF_LAB_CAPTURE_PROFILE ?? 'full', days: 2, fidelity: 'production-cadence', gates, passed: report.complete && report.triggerFidelity.verified && report.source.committedHarness && Object.values(gates).every(Boolean), source: report.source, productionRetries: report.productionRetries ?? [], report: 'replay-checkpoint.json' }
  await json(path.join(labRoot, 'evidence/two-day.json'), receipt)
  assert.ok(receipt.passed, `Two-day gates failed: ${Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`)
  return receipt
}
