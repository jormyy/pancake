#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const flag = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const count = Number(flag('count', '14'))
assert.ok([14, 15, 16, 17].includes(count), '--count=14|15|16|17')
const team = flag('team', 'E2E Team 1')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Seed before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
assert.match(new URL(env.SUPABASE_DB_URL).hostname, /^(127\.0\.0\.1|localhost)$/)

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) =>
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const json = (statement) => JSON.parse(sql(statement))

const scoring = '{"points":1,"rebounds":1,"assists":1,"steals":1,"blocks":1,"turnovers":-1,"three_pointers_made":1,"field_goals_made":0,"field_goals_attempted":0,"free_throws_made":0,"free_throws_attempted":0,"double_double":0,"triple_double":0}'

const ctx = json(`
  SELECT json_build_object(
    'leagueId', league.id,
    'seasonId', season.id,
    'seasonYear', season.season_year,
    'memberId', member.id,
    'teamName', member.team_name,
    'rosterSize', league.roster_size,
    'today', to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD'))
  FROM leagues league
  JOIN league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN league_members member ON member.league_id = league.id AND member.team_name = ${q(team)}
  WHERE league.id = ${q(fixture.leagueId)};`)
assert.ok(ctx, `Fixture league, current season and ${team} must exist`)

const week = json(`
  SELECT json_build_object(
    'weekNumber', coalesce((
      SELECT week.week_number FROM season_weeks week
       WHERE week.season_year = ${ctx.seasonYear}
         AND week.week_start <= ${q(ctx.today)}::date
         AND week.week_end >= ${q(ctx.today)}::date
       ORDER BY week.week_number LIMIT 1), 1),
    'weekEnd', ${q(ctx.today)}::date)
  FROM (SELECT 1) seed;`)

const priorFixturePlayers = `SELECT id FROM players WHERE first_name LIKE 'FloorFiller%' OR first_name LIKE 'OtherFiller%' OR first_name LIKE 'FloorFree%'`

const cleanup = [
  `DELETE FROM private.roster_floor_awards WHERE league_id = ${q(ctx.leagueId)}`,
  `DELETE FROM private.roster_floor_weeks WHERE league_id = ${q(ctx.leagueId)}`,
  `UPDATE trades SET status = 'withdrawn' WHERE league_id = ${q(ctx.leagueId)} AND status = 'pending'`,
  `DELETE FROM nba_games WHERE nba_game_id LIKE 'verify-auto-ir-%'`,
  `DELETE FROM roster_transactions WHERE league_id = ${q(ctx.leagueId)} AND transaction_type = 'fa_add'`,
  `DELETE FROM roster_transactions WHERE player_id IN (${priorFixturePlayers})`,
  `DELETE FROM waiver_claims WHERE player_id IN (${priorFixturePlayers})`,
  `DELETE FROM waiver_wire_log WHERE league_id = ${q(ctx.leagueId)} AND player_id IN (${priorFixturePlayers})`,
  `DELETE FROM roster_players WHERE league_id = ${q(ctx.leagueId)} AND player_id IN (${priorFixturePlayers})`,
  `DELETE FROM player_game_stats WHERE player_id IN (${priorFixturePlayers})`,
  `DELETE FROM player_season_averages WHERE league_id = ${q(ctx.leagueId)} AND player_id IN (${priorFixturePlayers})`,
  `DELETE FROM players WHERE id IN (${priorFixturePlayers}) AND NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.player_id = players.id)`,
]
sql(`BEGIN; ${cleanup.join('; ')}; COMMIT;`)

const statements = [
  `UPDATE leagues SET timezone = 'Pacific/Kiritimati', roster_size = greatest(roster_size, 20), scoring_settings = ${q(scoring)}::jsonb WHERE id = ${q(ctx.leagueId)}`,
  `INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
   VALUES (${q(ctx.leagueId)}, 16, true)
   ON CONFLICT (league_id) DO UPDATE SET weekly_roster_floor = 16, auto_ir_all_members = true`,
  `SELECT private.activate_league_roster_policy(${q(ctx.leagueId)})`,
  `INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
   VALUES (${ctx.seasonYear}, ${week.weekNumber}, ${q(week.weekEnd)}::date - 6, ${q(week.weekEnd)}::date)
   ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
   DO UPDATE SET week_start = EXCLUDED.week_start, week_end = EXCLUDED.week_end`,
  `INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
   SELECT ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${week.weekNumber}, ${q(ctx.memberId)}, other.id
     FROM league_members other
    WHERE other.league_id = ${q(ctx.leagueId)} AND other.id <> ${q(ctx.memberId)}
      AND NOT EXISTS (SELECT 1 FROM matchups matchup
        WHERE matchup.league_id = ${q(ctx.leagueId)} AND matchup.league_season_id = ${q(ctx.seasonId)}
          AND matchup.week_number = ${week.weekNumber})
    ORDER BY other.id LIMIT 1`,
  `DELETE FROM roster_players roster
    WHERE roster.league_id = ${q(ctx.leagueId)} AND roster.league_season_id = ${q(ctx.seasonId)}
      AND roster.member_id = ${q(ctx.memberId)} AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
      AND roster.id IN (
        SELECT kept.id FROM roster_players kept
         WHERE kept.league_id = ${q(ctx.leagueId)} AND kept.league_season_id = ${q(ctx.seasonId)}
           AND kept.member_id = ${q(ctx.memberId)} AND NOT kept.is_on_ir AND NOT kept.is_on_taxi
           AND NOT EXISTS (SELECT 1 FROM trade_items item JOIN trades trade ON trade.id = item.trade_id
             WHERE trade.league_id = kept.league_id AND trade.status IN ('pending', 'accepted')
               AND item.player_id = kept.player_id)
           AND NOT EXISTS (SELECT 1 FROM waiver_claims claim
             WHERE claim.league_id = kept.league_id AND claim.status = 'pending'
               AND claim.player_id = kept.player_id)
         ORDER BY kept.acquired_at DESC, kept.id DESC
         OFFSET ${count})`,
]

const active = Number(sql(`SELECT count(*) FROM roster_players
  WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
    AND member_id = ${q(ctx.memberId)} AND NOT is_on_ir AND NOT is_on_taxi`))
for (let index = active; index < count; index += 1) {
  const player = crypto.randomUUID()
  statements.push(`INSERT INTO players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES (${q(player)}, ${q(player)}, 'FloorFiller${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
  statements.push(`INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}, ${q(player)}, 'draft')`)
}

statements.push(`DO $fill$
DECLARE member_row record; index int; player uuid;
BEGIN
  FOR member_row IN SELECT id FROM league_members
    WHERE league_id = ${q(ctx.leagueId)} AND id <> ${q(ctx.memberId)} LOOP
    FOR index IN 1..greatest(0, 16 - (SELECT count(*) FROM roster_players roster
      WHERE roster.league_id = ${q(ctx.leagueId)} AND roster.league_season_id = ${q(ctx.seasonId)}
        AND roster.member_id = member_row.id AND NOT roster.is_on_ir AND NOT roster.is_on_taxi)) LOOP
      player := gen_random_uuid();
      INSERT INTO players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
        VALUES (player, player::text, 'OtherFiller', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ');
      INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
        VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, member_row.id, player, 'draft');
    END LOOP;
  END LOOP;
END;
$fill$`)

const freeAgents = []
const games = [crypto.randomUUID(), crypto.randomUUID()]
for (const game of games) {
  statements.push(`INSERT INTO nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES (${q(game)}, ${q('002' + game.replaceAll('-', '').slice(0, 10))}, ${ctx.seasonYear}, ${week.weekNumber},
      ${q(week.weekEnd)}::date - 3, now() - interval '3 days', 'ZZ', 'ZY', 'Final')`)
}
for (let index = 0; index < 6; index += 1) {
  const player = crypto.randomUUID()
  freeAgents.push(player)
  statements.push(`INSERT INTO players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES (${q(player)}, ${q(player)}, 'FloorFree${index}', 'Test', 'PG', ARRAY['PG'], NULL, 'ZZ')`)
  for (const game of games) {
    statements.push(`INSERT INTO player_game_stats(id, player_id, game_id, season_year, week_number, points, did_not_play, minutes_played)
      VALUES (gen_random_uuid(), ${q(player)}, ${q(game)}, ${ctx.seasonYear}, ${week.weekNumber}, ${40 - index}, false, 30)`)
  }
}
statements.push(`INSERT INTO waiver_wire_log(league_id, league_season_id, player_id, clears_at)
  SELECT ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, player.id, now() + interval '1 day'
    FROM players player
   WHERE NOT (player.id = ANY(ARRAY[${freeAgents.map(q).join(',')}]::uuid[]))
     AND NOT EXISTS (SELECT 1 FROM roster_players roster
       WHERE roster.league_id = ${q(ctx.leagueId)} AND roster.league_season_id = ${q(ctx.seasonId)}
         AND roster.player_id = player.id)`)

sql(`BEGIN; ${statements.join('; ')}; COMMIT;`)

sql(`SELECT private.refresh_queue_screen_views(${q(ctx.leagueId)})`)
sql(`SELECT private.refresh_player_averages(${q(ctx.leagueId)}, ${q(ctx.seasonId)},
  (SELECT version FROM private.screen_refresh_queue WHERE league_season_id = ${q(ctx.seasonId)}))`)
sql(`SELECT private.settle_waiver_runs('Pacific/Kiritimati', ${q(week.weekEnd)}::date, now())`)

const result = json(`
  SELECT json_build_object(
    'leagueId', ${q(ctx.leagueId)},
    'seasonId', ${q(ctx.seasonId)},
    'memberId', ${q(ctx.memberId)},
    'teamName', ${q(ctx.teamName)},
    'weekNumber', ${week.weekNumber},
    'weekEnd', ${q(week.weekEnd)},
    'floor', 16,
    'activated', (SELECT floor_activated_at IS NOT NULL AND ir_activated_at IS NOT NULL
      FROM private.league_roster_policies WHERE league_id = ${q(ctx.leagueId)}),
    'averagesReady', private.roster_floor_averages_ready(${q(ctx.leagueId)}, ${q(ctx.seasonId)}),
    'weekReady', private.roster_floor_week_ready(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${week.weekNumber}, ${q(week.weekEnd)}::date),
    'settled', EXISTS (SELECT 1 FROM private.waiver_run_settlements
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
        AND process_date = ${q(week.weekEnd)}::date),
    'activeBefore', (SELECT count(*) FROM roster_players
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
        AND member_id = ${q(ctx.memberId)} AND NOT is_on_ir AND NOT is_on_taxi),
    'freeAgents', (SELECT json_agg(json_build_object('playerId', player.id, 'name', player.display_name,
        'avgFantasyPoints', average.avg_fantasy_points) ORDER BY average.avg_fantasy_points DESC)
      FROM players player JOIN player_season_averages average
        ON average.league_id = ${q(ctx.leagueId)} AND average.season_year = ${ctx.seasonYear}
       AND average.player_id = player.id
      WHERE player.id = ANY(ARRAY[${freeAgents.map(q).join(',')}]::uuid[])),
    'expectedActive', least(16, roster_size))
  FROM leagues WHERE id = ${q(ctx.leagueId)};`)

assert.equal(result.activated, true, 'Fixture league must be activated through private.activate_league_roster_policy')
assert.equal(result.averagesReady, true, 'Averages cache must be ready through private.refresh_player_averages')
assert.equal(result.settled, true, 'Week must have a real waiver settlement')
assert.equal(result.weekReady.ready, true, `Week must be ready, got ${JSON.stringify(result.weekReady)}`)
assert.equal(result.freeAgents.length, 6, 'Six scored free agents')
assert.ok(result.freeAgents.every((agent) => agent.avgFantasyPoints > 0), 'Free agents must carry real averages')

console.log(JSON.stringify(result, null, 2))
