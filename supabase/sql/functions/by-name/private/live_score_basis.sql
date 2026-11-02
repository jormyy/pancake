CREATE OR REPLACE FUNCTION private.live_score_basis(p_league_id uuid, p_season_id uuid, p_week integer, p_date date, p_detail_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH matches AS MATERIALIZED (
    SELECT m.* FROM public.matchups m WHERE m.league_id=p_league_id AND m.league_season_id=p_season_id
      AND NOT m.is_voided AND m.week_number<=p_week AND COALESCE(m.end_week_number,m.week_number)>=p_week
  ), members AS MATERIALIZED (
    SELECT id, home_member_id AS member_id FROM matches UNION ALL SELECT id, away_member_id FROM matches
  ), totals AS MATERIALIZED (
    SELECT m.id, member.member_id, COALESCE(sum(public.compute_fantasy_points(stat.id,p_league_id)),0) AS points
    FROM matches m JOIN members member ON member.id=m.id
    LEFT JOIN public.weekly_lineups lineup ON lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id
      AND lineup.member_id=member.member_id AND lineup.week_number BETWEEN m.week_number AND COALESCE(m.end_week_number,m.week_number)
      AND lineup.slot_type NOT IN ('BE','IR')
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN public.season_weeks week ON week.season_year=season.season_year AND week.week_number=lineup.week_number
    LEFT JOIN public.player_game_stats stat ON stat.player_id=lineup.player_id AND stat.game_date=lineup.game_date
      AND stat.season_year=season.season_year AND stat.game_date BETWEEN week.week_start AND week.week_end
    GROUP BY m.id,member.member_id
  ), players AS MATERIALIZED (
    SELECT member.id,member.member_id,lineup.player_id,true AS starter FROM members member
      JOIN public.weekly_lineups lineup ON lineup.member_id=member.member_id AND lineup.league_id=p_league_id
        AND lineup.league_season_id=p_season_id AND lineup.game_date=p_date AND lineup.slot_type NOT IN ('BE','IR')
    UNION ALL
    SELECT member.id,member.member_id,roster.player_id,false FROM members member
      JOIN public.roster_players roster ON roster.member_id=member.member_id AND roster.league_id=p_league_id
        AND roster.league_season_id=p_season_id
      WHERE member.id=p_detail_matchup_id AND NOT EXISTS(SELECT 1 FROM public.weekly_lineups lineup WHERE lineup.member_id=member.member_id
        AND lineup.league_id=p_league_id AND lineup.league_season_id=p_season_id AND lineup.game_date=p_date
        AND lineup.player_id=roster.player_id AND lineup.slot_type NOT IN ('BE','IR'))
  ), memberships AS MATERIALIZED (
    SELECT membership.* FROM private.player_game_memberships membership JOIN public.nba_games game ON game.id=membership.game_id
      WHERE game.game_date=p_date
  ), lines AS MATERIALIZED (
    SELECT selected.id,jsonb_agg(jsonb_build_object('playerId',player.id,'memberId',selected.member_id,
      'nbaId',player.nba_id,'espnId',player.espn_id,'team',COALESCE(membership.nba_team,player.nba_team),
      'gameId',game.nba_game_id,'savedPoints',public.compute_fantasy_points(stat.id,p_league_id),
      'savedAt',COALESCE(extract(epoch FROM feed.stats_updated_at)*1000,0),'starter',selected.starter,
      'final',game.status='Final' AND game.stats_synced_at IS NOT NULL) ORDER BY selected.member_id,player.id,game.id) AS data
    FROM players selected JOIN public.players player ON player.id=selected.player_id
    LEFT JOIN public.league_seasons season ON season.id=p_season_id
    LEFT JOIN memberships membership ON membership.player_id=player.id
    LEFT JOIN public.nba_games game ON game.game_date=p_date AND game.season_year=season.season_year
      AND public.is_regular_season_game_id(game.nba_game_id)
      AND (game.id=membership.game_id OR membership.game_id IS NULL AND player.nba_team IN (game.home_team,game.away_team))
    LEFT JOIN public.player_game_stats stat ON stat.player_id=player.id AND stat.game_id=game.id
    LEFT JOIN private.live_feed_state feed ON feed.game_id=game.id
    GROUP BY selected.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'homeMemberId',m.home_member_id,'awayMemberId',m.away_member_id,
    'homePoints',COALESCE(m.home_points,0),'awayPoints',COALESCE(m.away_points,0),'finalized',COALESCE(m.is_finalized,false),
    'ready',COALESCE(m.home_points,0)=home.points AND COALESCE(m.away_points,0)=away.points,
    'players',COALESCE(lines.data,'[]'::jsonb)) ORDER BY m.id),'[]'::jsonb)
  FROM matches m JOIN totals home ON home.id=m.id AND home.member_id=m.home_member_id
    JOIN totals away ON away.id=m.id AND away.member_id=m.away_member_id LEFT JOIN lines ON lines.id=m.id;
$$;
