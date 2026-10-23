import assert from 'node:assert/strict'
import { dates } from './common.mjs'

export function recoveryEvidence(snapshot, receipt, profile) {
  const cursor = snapshot.cursor
  assert.equal(snapshot.clock.rate, 0, 'Recovery requires a paused checkpoint')
  assert.equal(snapshot.quiescence.workers?.length ?? 0, 0)
  assert.equal(snapshot.quiescence.polls > 0, true, 'Recovery requires an observed worker drain')
  assert.equal(cursor.clock, snapshot.clock.simMs ?? snapshot.clock.sim_ms)
  assert.ok(cursor.date >= profile.start && cursor.date <= profile.end)
  assert.ok(cursor.clock < Date.parse(`${cursor.date}T23:59:59Z`), 'Recovery cursor cannot pass its first date')
  const days = [...(receipt.recovery?.retainedReceipts ?? []), ...receipt.days].filter(day => day.date < cursor.date)
  assert.deepEqual(days.map(day => day.date), dates(profile.start, cursor.date).slice(0, -1), 'Recovery requires every preceding date receipt')
  assert.ok(days.every(day => day.finals.passed || day.finals.games === 0), 'Recovery requires verified preceding finals')
  assert.equal(receipt.leagueId, cursor.context.leagueId)
  assert.equal(receipt.leagueSeasonId, cursor.context.leagueSeasonId)
  const before = row => Date.parse(row.businessAt) <= cursor.clock
  return {
    featureCheckpoints: (receipt.featureCheckpoints ?? []).filter(before),
    playersEvidence: (receipt.playersEvidence ?? []).filter(before),
    realInputChecks: (receipt.realInputChecks ?? []).filter(row => row.date < cursor.date),
    recovery: { date: cursor.date, clock: cursor.clock, retainedDates: days.length, retainedGames: days.reduce((sum, day) => sum + day.finals.games, 0), retainedReceipts: days.map(({ date, finals }) => ({ date, finals })), dumpSha256: snapshot.dumpSha256 },
  }
}

export function recoveryHistoryQuery(date) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  return `SELECT json_build_object(
    'games',(SELECT count(*) FROM nba_games WHERE game_date<'${date}' AND status='Final'),
    'stats',(SELECT md5(string_agg((to_jsonb(s)-'updated_at')::text,'' ORDER BY s.id)) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.game_date<'${date}'),
    'lineups',(SELECT md5(string_agg((to_jsonb(l)-'updated_at')::text,'' ORDER BY l.id)) FROM weekly_lineups l WHERE l.game_date<'${date}'),
    'matchups',(SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY m.id)) FROM matchups m JOIN league_seasons l ON l.id=m.league_season_id JOIN season_weeks w ON w.season_year=l.season_year AND w.week_number=coalesce(m.end_week_number,m.week_number) WHERE m.is_finalized AND w.week_end<'${date}'))`
}
