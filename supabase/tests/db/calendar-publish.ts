import assert from 'node:assert/strict'
import { buildScheduleSyncPlan, buildSeasonWeekRows } from '../../functions/_shared/schedule.ts'
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const requested = Deno.env.get('POST_CALENDAR_CASE')
if (requested === 'matchup-order') {
  await import('./matchup-order-seasons.ts')
  Deno.exit(0)
}
const cases = requested ? [requested] : ['missing', 'published', 'contract']
for (const selected of cases) {
assert.ok(['missing', 'published', 'contract'].includes(selected))
const fixture = JSON.parse(await Deno.readTextFile(new URL('../../../tests/fixtures/calendar/espn-2024-2025.json', import.meta.url)))
const plan = buildScheduleSyncPlan(fixture.games, new Date('2024-10-01T00:00:00Z'))
const rows = plan.rows.map(row => ({ ...row, season_year: 9525, game_date: String(Number(row.game_date.slice(0, 4)) + 7500) + row.game_date.slice(4),
  game_time: null, started_at: null, week_number: fixture.games.find((game: { gameId: string }) => game.gameId === row.nba_game_id).weekNumber, schedule_complete: true }))
const weeks = buildSeasonWeekRows(rows, 9525)
const merged = rows.map(row => ({ ...row, week_number: row.week_number >= 18 ? row.week_number - 1 : row.week_number }))
const mergedWeeks = buildSeasonWeekRows(merged, 9525)
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const sql = `BEGIN;
SET LOCAL statement_timeout='60s';
DO $$
DECLARE rows jsonb:=${quote(rows)}; weeks jsonb:=${quote(weeks)}; merged jsonb:=${quote(merged)}; merged_weeks jsonb:=${quote(mergedWeeks)};
  target text:=rows->0->>'nba_game_id'; old_weeks jsonb; old_games jsonb; old_matchup jsonb;
  usr uuid:=gen_random_uuid(); other_usr uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); home uuid:=gen_random_uuid(); away uuid:=gen_random_uuid();
BEGIN
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=9525) THEN RAISE EXCEPTION 'Synthetic year is occupied'; END IF;
  IF '${selected}'='contract' THEN rows:=merged; weeks:=merged_weeks; END IF;
  rows:=jsonb_set(rows,'{0,status}','"Scheduled"'); rows:=jsonb_set(rows,'{0,game_status_text}','null');
  PERFORM publish_nba_schedule_atomic(9525,rows,weeks);
  IF '${selected}'='missing' THEN
    PERFORM publish_nba_schedule_atomic(9525,rows-0,weeks);
    IF (SELECT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=target) THEN
      RAISE EXCEPTION 'FAIL: a non-final game missing from a complete season feed remains available';
    END IF;
    UPDATE nba_games SET game_status_text=NULL WHERE nba_game_id=target;
    PERFORM publish_nba_schedule_atomic(9525,jsonb_build_array(rows->1),weeks);
    IF (SELECT NOT private.lineup_game_available(status,game_status_text) FROM nba_games WHERE nba_game_id=target) THEN
      RAISE EXCEPTION 'FAIL: a partial feed marks an unseen game unavailable';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=9525 AND status='Final') THEN RAISE EXCEPTION 'Final game history disappeared'; END IF;
    RAISE NOTICE 'PASS: complete-feed disappearance, partial-feed safety, and final history';
  ELSE
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
    VALUES(usr,'authenticated','authenticated',usr||'@example.test','{}','{}'),(other_usr,'authenticated','authenticated',other_usr||'@example.test','{}','{}');
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths) VALUES(league,'Synthetic published calendar',league::text,usr,'setup',20,2,ARRAY[2]);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,9525,true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(home,league,usr,'commissioner','Home'),(away,league,other_usr,'manager','Away');
    IF '${selected}'='contract' THEN
      PERFORM set_config('request.jwt.claim.sub',usr::text,true);
      PERFORM update_league_settings_atomic(league,'{"skipped_weeks":[1]}'::jsonb);
      PERFORM replace_regular_season_matchups_atomic(league,season,false,private.regular_season_matchup_payload(league,season,19));
      IF (SELECT count(*)<>18 OR min(week_number)<>2 OR max(week_number)<>19 FROM matchups WHERE league_season_id=season)
        OR EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND week_number=1)
        OR (SELECT count(*)<>1 FROM matchups WHERE league_season_id=season AND week_number=17) THEN
        RAISE EXCEPTION 'FAIL: delayed league start and the merged matchup schedule differ from saved fantasy weeks';
      END IF;
      PERFORM private.assert_score_calendar(season,17);
      PERFORM private.assert_playoff_window(9525,20,ARRAY[2],true);
      BEGIN
        PERFORM private.assert_playoff_window(9525,24,ARRAY[2]);
        RAISE EXCEPTION 'A playoff span beyond the merged season was accepted';
      EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
      UPDATE matchups SET is_finalized=true,finalized_at=now()-interval '73 hours',winner_member_id=home_member_id,home_points=10,away_points=5 WHERE league_season_id=season;
      PERFORM private.rebuild_regular_standings(league,season);
      PERFORM generate_playoff_bracket_atomic(league);
      IF NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_final' AND week_number=20 AND end_week_number=21) THEN
        RAISE EXCEPTION 'FAIL: playoff round weeks shift away from saved fantasy numbers';
      END IF;
      IF private.trade_deadline_for_season('2000-02-06',2025)<>'2025-02-06'::date
        OR private.trade_deadline_for_season('2000-02-05',2026)<>'2026-02-05'::date THEN
        RAISE EXCEPTION 'FAIL: the calendar merge changes a date-based trade deadline';
      END IF;
      RAISE NOTICE 'PASS: real-shaped merged ranges, delayed start, scoring calendar, playoff bounds, bracket spans, and unchanged date deadlines';
      RETURN;
    END IF;
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,is_finalized,finalized_at,home_points,away_points)
    VALUES(league,season,20,home,away,true,now(),42,21);
    SELECT jsonb_agg(to_jsonb(week) ORDER BY week_number) INTO old_weeks FROM season_weeks week WHERE season_year=9525;
    SELECT jsonb_agg(jsonb_build_array(nba_game_id,game_date,week_number) ORDER BY nba_game_id) INTO old_games FROM nba_games WHERE season_year=9525;
    SELECT to_jsonb(matchup) INTO old_matchup FROM matchups matchup WHERE league_season_id=season;
    PERFORM publish_nba_schedule_atomic(9525,merged,merged_weeks);
    PERFORM publish_nba_schedule_atomic(9525,merged,merged_weeks);
    IF old_weeks IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(week) ORDER BY week_number) FROM season_weeks week WHERE season_year=9525)
      OR old_games IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(nba_game_id,game_date,week_number) ORDER BY nba_game_id) FROM nba_games WHERE season_year=9525)
      OR old_matchup IS DISTINCT FROM (SELECT to_jsonb(matchup) FROM matchups matchup WHERE league_season_id=season) THEN
      RAISE EXCEPTION 'FAIL: daily sync renumbers a published calendar or changes finalized matchup history';
    END IF;
    RAISE NOTICE 'PASS: published NBA numbering stays exact through two merged-calendar syncs with finalized results';
  END IF;
END; $$;
ROLLBACK;`
const child = new Deno.Command('psql', { args: [db, '-Xv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'inherit', stderr: 'inherit' }).spawn()
const writer = child.stdin.getWriter()
await writer.write(new TextEncoder().encode(sql))
await writer.close()
const status = await child.status
if (!status.success) Deno.exit(status.code)
}
Deno.exit(0)
