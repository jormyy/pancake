BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION private.fantasy_points_rows(p_league_id uuid, p_stat_ids uuid[])
RETURNS TABLE(stat_id uuid, points numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT stat.id, round(
      COALESCE(stat.points,0)*COALESCE((league.scoring_settings->>'points')::numeric,0) +
      COALESCE(stat.rebounds,0)*COALESCE((league.scoring_settings->>'rebounds')::numeric,0) +
      COALESCE(stat.assists,0)*COALESCE((league.scoring_settings->>'assists')::numeric,0) +
      COALESCE(stat.steals,0)*COALESCE((league.scoring_settings->>'steals')::numeric,0) +
      COALESCE(stat.blocks,0)*COALESCE((league.scoring_settings->>'blocks')::numeric,0) +
      COALESCE(stat.turnovers,0)*COALESCE((league.scoring_settings->>'turnovers')::numeric,0) +
      COALESCE(stat.three_pointers_made,0)*COALESCE((league.scoring_settings->>'three_pointers_made')::numeric,0) +
      COALESCE(stat.field_goals_made,0)*COALESCE((league.scoring_settings->>'field_goals_made')::numeric,0) +
      COALESCE(stat.field_goals_attempted,0)*COALESCE((league.scoring_settings->>'field_goals_attempted')::numeric,0) +
      COALESCE(stat.free_throws_made,0)*COALESCE((league.scoring_settings->>'free_throws_made')::numeric,0) +
      COALESCE(stat.free_throws_attempted,0)*COALESCE((league.scoring_settings->>'free_throws_attempted')::numeric,0) +
      CASE WHEN stat.double_double THEN COALESCE((league.scoring_settings->>'double_double')::numeric,0) ELSE 0 END +
      CASE WHEN stat.triple_double THEN COALESCE((league.scoring_settings->>'triple_double')::numeric,0) ELSE 0 END
    ,2)
  FROM public.player_game_stats stat
  JOIN public.nba_games game ON game.id=stat.game_id
  JOIN public.leagues league ON league.id=p_league_id
  WHERE stat.id = ANY(p_stat_ids)
    AND public.is_regular_season_game_id(game.nba_game_id)
    AND NOT stat.did_not_play
$$;

CREATE OR REPLACE FUNCTION private.live_score_basis(p_league_id uuid, p_season_id uuid, p_week integer, p_date date, p_detail_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH matches AS MATERIALIZED (
    SELECT m.* FROM public.matchups m WHERE m.league_id=p_league_id AND m.league_season_id=p_season_id
      AND NOT m.is_voided AND m.week_number<=p_week AND COALESCE(m.end_week_number,m.week_number)>=p_week
  ), members AS MATERIALIZED (
    SELECT id, home_member_id AS member_id FROM matches UNION ALL SELECT id, away_member_id FROM matches
  ), totals_raw AS MATERIALIZED (
    SELECT m.id, member.member_id, array_agg(stat.id) AS stat_ids
    FROM matches m JOIN members member ON member.id=m.id
    LEFT JOIN public.weekly_lineups lineup ON lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id
      AND lineup.member_id=member.member_id AND lineup.week_number BETWEEN m.week_number AND COALESCE(m.end_week_number,m.week_number)
      AND lineup.slot_type NOT IN ('BE','IR')
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN public.season_weeks week ON week.season_year=season.season_year AND week.week_number=lineup.week_number
    LEFT JOIN public.player_game_stats stat ON stat.player_id=lineup.player_id AND stat.game_date=lineup.game_date
      AND stat.season_year=season.season_year AND stat.game_date BETWEEN week.week_start AND week.week_end
    GROUP BY m.id,member.member_id
  ), totals AS MATERIALIZED (
    SELECT raw.id, raw.member_id, COALESCE((SELECT sum(points) FROM private.fantasy_points_rows(p_league_id, raw.stat_ids)),0) AS points
    FROM totals_raw raw
  ), players AS MATERIALIZED (
    SELECT member.id,member.member_id,lineup.player_id,lineup.game_date,true AS starter FROM members member JOIN matches ON matches.id=member.id
      JOIN public.weekly_lineups lineup ON lineup.member_id=member.member_id AND lineup.league_id=p_league_id
        AND lineup.league_season_id=p_season_id AND lineup.week_number BETWEEN matches.week_number AND COALESCE(matches.end_week_number,matches.week_number)
        AND lineup.slot_type NOT IN ('BE','IR')
      WHERE lineup.game_date=p_date OR EXISTS(SELECT 1 FROM public.nba_games game WHERE game.game_date=lineup.game_date
        AND game.season_year=(SELECT season_year FROM public.league_seasons WHERE id=p_season_id)
        AND (game.status='InProgress' OR game.status='Final' AND game.stats_synced_at IS NULL))
    UNION ALL
    SELECT member.id,member.member_id,roster.player_id,p_date,false FROM members member
      JOIN public.roster_players roster ON roster.member_id=member.member_id AND roster.league_id=p_league_id
        AND roster.league_season_id=p_season_id
      WHERE member.id=p_detail_matchup_id AND NOT EXISTS(SELECT 1 FROM public.weekly_lineups lineup WHERE lineup.member_id=member.member_id
        AND lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id AND lineup.game_date=p_date
        AND lineup.player_id=roster.player_id AND lineup.slot_type NOT IN ('BE','IR'))
  ), memberships AS MATERIALIZED (
    SELECT membership.*,game.game_date AS live_date FROM private.player_game_memberships membership JOIN public.nba_games game ON game.id=membership.game_id
      WHERE game.season_year=(SELECT season_year FROM public.league_seasons WHERE id=p_season_id)
        AND game.game_date IN (SELECT game_date FROM players)
  ), lines AS MATERIALIZED (
    SELECT selected.id,jsonb_agg(jsonb_build_object('playerId',player.id,'memberId',selected.member_id,
      'nbaId',player.nba_id,'espnId',player.espn_id,'team',COALESCE(membership.nba_team,player.nba_team),
      'gameId',game.nba_game_id,'gameDate',selected.game_date,'savedPoints',public.compute_fantasy_points(stat.id,p_league_id),
      'savedAt',COALESCE(extract(epoch FROM feed.stats_updated_at)*1000,0),'starter',selected.starter,
      'final',game.status='Final' AND game.stats_synced_at IS NOT NULL) ORDER BY selected.member_id,player.id,game.id) AS data
    FROM players selected JOIN public.players player ON player.id=selected.player_id
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN memberships membership ON membership.player_id=player.id AND membership.live_date=selected.game_date
    LEFT JOIN public.nba_games game ON game.game_date=selected.game_date AND game.season_year=season.season_year
      AND public.is_regular_season_game_id(game.nba_game_id)
      AND (game.id=membership.game_id OR membership.game_id IS NULL AND player.nba_team IN (game.home_team,game.away_team))
    LEFT JOIN public.player_game_stats stat ON stat.player_id=player.id AND stat.game_id=game.id
    LEFT JOIN private.live_feed_state feed ON feed.game_id=game.id
    WHERE (selected.game_date=p_date OR game.status='InProgress' OR game.status='Final' AND game.stats_synced_at IS NULL)
      AND (game.status IS NULL OR private.lineup_game_available(game.status,game.game_status_text))
    GROUP BY selected.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'homeMemberId',m.home_member_id,'awayMemberId',m.away_member_id,
    'homePoints',COALESCE(m.home_points,0),'awayPoints',COALESCE(m.away_points,0),'finalized',COALESCE(m.is_finalized,false),
    'ready',COALESCE(m.home_points,0)=home.points AND COALESCE(m.away_points,0)=away.points,
    'players',COALESCE(lines.data,'[]'::jsonb)) ORDER BY m.id),'[]'::jsonb)
  FROM matches m JOIN totals home ON home.id=m.id AND home.member_id=m.home_member_id
    JOIN totals away ON away.id=m.id AND away.member_id=m.away_member_id LEFT JOIN lines ON lines.id=m.id;
$$;

REVOKE ALL ON FUNCTION private.fantasy_points_rows(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
