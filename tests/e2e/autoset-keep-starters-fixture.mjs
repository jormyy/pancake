import assert from 'node:assert/strict'
import path from 'node:path'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { json, project, ports, requireMini } from '../../scripts/perf-lab/common.mjs'

await requireMini()
assert.equal(project, 'pt4bafableas')
assert.equal(ports.api, 64021)
const fixture = JSON.parse(await sql(`WITH member AS (
    SELECT m.id, m.league_id, s.id season_id, s.season_year, m.team_name
    FROM league_members m JOIN profiles p ON p.id=m.user_id
    JOIN league_seasons s ON s.league_id=m.league_id AND s.is_current
    WHERE m.league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' AND m.id='9fe20af7-b2fb-4ab6-bd42-2e2e7ccc5dd9'
), roster AS (
    SELECT p.id AS "playerId", p.display_name AS "displayName", p.nba_team AS "nbaTeam",
      COALESCE(NULLIF(p.eligible_positions,'{}'::text[]),ARRAY[p.position::text]) AS "eligiblePositions",
      p.injury_status AS "injuryStatus", r.is_on_ir AS "isOnIr", r.is_on_taxi AS "isOnTaxi"
    FROM member m JOIN roster_players r ON r.member_id=m.id AND r.league_season_id=m.season_id
    JOIN players p ON p.id=r.player_id
) SELECT jsonb_build_object('source','pancake-db-backup-2026-10-28',
    'member',(SELECT to_jsonb(m) FROM member m),
    'roster',(SELECT jsonb_agg(r ORDER BY "playerId") FROM roster r),
    'templates',(SELECT jsonb_agg(jsonb_build_object('slotType',slot_type,'count',slot_count) ORDER BY slot_type)
      FROM lineup_slot_templates WHERE league_id=(SELECT league_id FROM member) AND slot_type NOT IN ('BE','IR')),
    'days',(SELECT jsonb_agg(jsonb_build_object('date',day::date,
      'weekNumber',(SELECT week_number FROM season_weeks WHERE season_year=(SELECT season_year FROM member) AND day::date BETWEEN week_start AND week_end),
      'stored',COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id',player_id,'slot_type',slot_type,'is_auto_set',is_auto_set,'week_number',week_number,'locked',false) ORDER BY player_id)
        FROM weekly_lineups WHERE member_id=(SELECT id FROM member) AND game_date=day::date),'[]'::jsonb),
      'games',COALESCE((SELECT jsonb_agg(jsonb_build_object('homeTeam',home_team,'awayTeam',away_team,'status',status,'gameTime',game_time) ORDER BY id)
        FROM nba_games WHERE game_date=day::date AND season_year=(SELECT season_year FROM member)),'[]'::jsonb),
      'projections',COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id',pr.player_id,'projection_fantasy_points',pr.projection_fantasy_points))
        FROM member m CROSS JOIN LATERAL get_league_projection_rows(m.league_id,m.season_year,day::date,'today',ARRAY(SELECT "playerId" FROM roster),1000,0) pr),'[]'::jsonb)) ORDER BY day)
      FROM generate_series('2026-10-29'::date,'2026-10-30'::date,interval '1 day') day));`))
assert.ok(fixture.member, 'Michael member must exist in OFFICIAL LEAGUE')
assert.ok(fixture.roster.length > 10)
await json(path.resolve('tests/fixtures/autoset-michael.json'), fixture)
console.log(JSON.stringify({ team: fixture.member.team_name, roster: fixture.roster.length, days: fixture.days.map(day => ({ date: day.date, stored: day.stored.length, games: day.games.length })) }))
