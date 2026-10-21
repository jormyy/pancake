import assert from 'node:assert/strict'
import { buildScheduleSyncPlan } from '../../functions/_shared/schedule.ts'
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const examples = [
  [2024, 'CHA', 'LAL', '2025-01-09', '2025-02-19'],
  [2024, 'SAS', 'LAL', '2025-01-11', '2025-03-17'],
  [2025, 'MIA', 'CHI', '2026-01-08', '2026-01-29'],
  [2025, 'GSW', 'MIN', '2026-01-24', '2026-01-25'],
  [2025, 'DEN', 'MEM', '2026-01-25', '2026-03-18'],
  [2025, 'DAL', 'MIL', '2026-01-25', '2026-03-31'],
] as const
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
for (const [index, [start, away, home, original, makeup]] of examples.entries()) {
  const fixture = JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/calendar/espn-${start}-${start + 1}.json`, import.meta.url)))
  const postponed = fixture.postponements.find((game: { gameDate: string; homeTeam: string; awayTeam: string }) => game.gameDate === original && game.homeTeam === home && game.awayTeam === away)
  const played = fixture.games.find((game: { gameDate: string; homeTeam: string; awayTeam: string; status: string }) => game.gameDate === makeup && game.homeTeam === home && game.awayTeam === away && game.status === 'Final')
  assert.ok(postponed, `REAL-RAW original postponed event: ${away}@${home} ${original}`)
  assert.ok(played, `REAL-RAW played event: ${away}@${home} ${makeup}`)
  const plan = buildScheduleSyncPlan(fixture.games, new Date(`${start}-10-01T00:00:00Z`))
  const originalWeek = plan.weeks.find(week => week.week_start <= original && week.week_end >= original)!.week_number
  const playedWeek = plan.weeks.find(week => week.week_start <= makeup && week.week_end >= makeup)!.week_number
  const shift = (date: string) => String(Number(date.slice(0, 4)) + 7000) + date.slice(4)
  const year = start + 7001
  const weeks = plan.weeks.map(week => ({ ...week, season_year: year, week_start: shift(week.week_start), week_end: shift(week.week_end) }))
  const key = `002-real-makeup-${crypto.randomUUID()}`
  const before = { nba_game_id: key, season_year: year, game_date: shift(original), week_number: originalWeek, home_team: home, away_team: away, status: 'Scheduled', game_status_text: 'Postponed', game_time: `${shift(original)}T23:00:00Z` }
  const after = { ...before, game_date: shift(makeup), week_number: playedWeek, status: 'Final', game_status_text: 'Final', game_time: `${shift(makeup)}T23:00:00Z` }
  const statement = `BEGIN; SET LOCAL statement_timeout='30s';
    SELECT publish_nba_schedule_atomic(${year},${quote([before])},${quote(weeks)});
    SELECT publish_nba_schedule_atomic(${year},${quote([{ ...before, game_status_text: '', game_time: `${shift(original)}T22:00:00Z` }])},'[]');
    DO $$ BEGIN IF (SELECT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id='${key}') THEN RAISE EXCEPTION 'Stale text reopens a real postponed event'; END IF; END $$;
    SELECT publish_nba_schedule_atomic(${year},${quote([after])},'[]');
    SELECT publish_nba_schedule_atomic(${year},${quote([after])},'[]');
    DO $$ BEGIN IF NOT (SELECT count(*)=1 AND bool_and(week_number=${playedWeek} AND game_date='${shift(makeup)}' AND private.lineup_game_available(status,game_status_text)) FROM nba_games WHERE nba_game_id='${key}') THEN RAISE EXCEPTION 'A real makeup duplicates or keeps its old week'; END IF; END $$;
    ROLLBACK;`
  const child = new Deno.Command('psql', { args: [db, '-Xqv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'null', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter(); await writer.write(new TextEncoder().encode(statement)); await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  console.log(JSON.stringify({ provenance: 'REAL-DERIVED inputs; SYNTHETIC isolated DB year and stable ID', index, away, home, original, makeup, originalWeek, playedWeek, originalEspnId: postponed.espnId, makeupEspnId: played.espnId, source: fixture.sources.filter((source: { date: string }) => (source.date === original || source.date === makeup)) }))
}
