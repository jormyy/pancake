BEGIN;

CREATE OR REPLACE FUNCTION public.view_player(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; lines jsonb; transactions jsonb; projection jsonb;
  games jsonb; fantasy_map jsonb;
BEGIN
  IF p_params->>'section' IN ('overview', 'games', 'news', 'history') THEN
    DECLARE
      context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; projection jsonb;
      items jsonb; own public.roster_players%ROWTYPE; owner_name text; waiver_time timestamptz;
      page_size integer := LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100);
    BEGIN
      context := public.view_context(p_league_id, p_member_id, p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
      SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
      IF p_params->>'section' = 'games' THEN
        DECLARE
          cursor_value jsonb := p_params->'gameAfter';
          cursor_date date;
          cursor_id uuid;
          has_more boolean;
          last_item jsonb;
        BEGIN
          IF cursor_value IS NOT NULL AND cursor_value <> 'null'::jsonb THEN
            IF jsonb_typeof(cursor_value) <> 'object' OR NOT cursor_value ?& ARRAY['date','id']
              OR cursor_value->>'id' IS NULL THEN
              RAISE EXCEPTION 'Invalid game cursor.' USING ERRCODE='22023';
            END IF;
            cursor_date := (cursor_value->>'date')::date;
            cursor_id := (cursor_value->>'id')::uuid;
          END IF;
          SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game))
            ORDER BY stat.game_date DESC NULLS FIRST, stat.id DESC), '[]') INTO items
          FROM (
            SELECT stat.id,stat.player_id,stat.game_id,stat.season_year,stat.week_number,stat.game_date,
              stat.minutes_played,stat.points,stat.rebounds,stat.assists,stat.steals,stat.blocks,stat.turnovers,
              stat.personal_fouls,stat.field_goals_made,stat.field_goals_attempted,stat.three_pointers_made,
              stat.three_pointers_attempted,stat.free_throws_made,stat.free_throws_attempted,stat.plus_minus,
              stat.double_double,stat.triple_double,stat.did_not_play,stat.created_at,stat.updated_at,
              stat.is_home,stat.offensive_rebounds,stat.defensive_rebounds
            FROM public.player_game_stats stat JOIN public.nba_games game ON game.id=stat.game_id
            WHERE stat.player_id=player.id AND stat.season_year=(context->>'seasonYear')::integer
              AND game.nba_game_id LIKE '002%'
              AND (cursor_id IS NULL
                OR cursor_date IS NULL AND (stat.game_date IS NOT NULL OR stat.id<cursor_id)
                OR cursor_date IS NOT NULL AND (stat.game_date,stat.id)<(cursor_date,cursor_id))
            ORDER BY stat.game_date DESC NULLS FIRST,stat.id DESC LIMIT page_size+1
          ) stat JOIN public.nba_games game ON game.id=stat.game_id;
          has_more := jsonb_array_length(items)>page_size;
          SELECT COALESCE(jsonb_agg(value ORDER BY ordinal),'[]') INTO items
            FROM jsonb_array_elements(items) WITH ORDINALITY row(value,ordinal) WHERE ordinal<=page_size;
          last_item := items->(jsonb_array_length(items)-1);
          RETURN jsonb_build_object('context',context,'lines',items,'hasMoreGames',has_more,
            'nextGameCursor',CASE WHEN has_more THEN jsonb_build_object('date',last_item->'game_date','id',last_item->'id') END);
        END;
      ELSIF p_params->>'section' = 'news' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.published_at DESC, item.id), '[]') INTO items
          FROM (SELECT id, title, summary, source, url, published_at FROM public.dynasty_news
            WHERE player_id = player.id ORDER BY published_at DESC, id LIMIT 20) item;
        RETURN jsonb_build_object('context', context, 'news', items);
      ELSIF p_params->>'section' = 'history' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
          WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
          WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
          WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
          WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
          'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]') INTO items
          FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
            ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
        RETURN jsonb_build_object('context', context, 'transactions', items);
      END IF;
      SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
        WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
      IF NOT FOUND THEN
        SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
        SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
      END IF;
      SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
        (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
      SELECT r.* INTO own FROM public.roster_players r WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid AND r.player_id = player.id LIMIT 1;
      SELECT team_name INTO owner_name FROM public.league_members WHERE id = own.member_id;
      SELECT max(clears_at) INTO waiver_time FROM public.waiver_wire_log WHERE league_id = p_league_id AND player_id = player.id AND cleared_at IS NULL AND clears_at > now() AND league_season_id = (context->>'seasonId')::uuid;
      RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)),
        'five_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1),
        'three_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com/points-3' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)),
        'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
          SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id UNION SELECT public.current_season_year_et()) years), '[]'),
        'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
          'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
          'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
          'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
          'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
          'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
          'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
        'avgFantasyPoints', fantasy, 'nextProjection', projection, 'scoringSettings', context->'league'->'scoring_settings',
        'pickup', jsonb_build_object('status', CASE WHEN own.member_id = p_member_id THEN jsonb_build_object('status', 'mine', 'rosterPlayerId', own.id, 'isOnTaxi', own.is_on_taxi)
          WHEN own.id IS NOT NULL THEN jsonb_build_object('status', 'taken', 'ownerTeamName', COALESCE(owner_name, 'Team'), 'isOnTaxi', own.is_on_taxi)
          WHEN waiver_time IS NOT NULL THEN jsonb_build_object('status', 'on_waivers', 'logId', '', 'clearsAt', waiver_time) ELSE jsonb_build_object('status', 'free_agent') END,
          'transactionState', public.view_transaction_state(p_league_id, p_member_id, p_params),
          'claimPending', EXISTS (SELECT 1 FROM public.waiver_claims WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid AND player_id = player.id AND status = 'pending'),
          'roster', COALESCE((SELECT jsonb_agg(jsonb_build_object('is_on_ir', is_on_ir, 'is_on_taxi', is_on_taxi)) FROM public.roster_players WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid), '[]')));
    END;
  END IF;
  context := public.view_context(p_league_id, p_member_id,
    p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
  SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
    WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  IF NOT FOUND THEN
    SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
    SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game)) ORDER BY stat.game_date DESC, stat.id DESC), '[]')
    INTO lines FROM (SELECT stat.* FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id
      WHERE stat.player_id = player.id AND stat.season_year = (context->>'seasonYear')::integer AND game.nba_game_id LIKE '002%'
      ORDER BY stat.game_date DESC, stat.id DESC LIMIT 100) stat JOIN public.nba_games game ON game.id = stat.game_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
    WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
    WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
    WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
    WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]')
    INTO transactions FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
      ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
  SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
    (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
  WITH ordered AS (
    SELECT line, line->'nba_games' AS game, COALESCE((line->>'is_home')::boolean,
      CASE WHEN line->'nba_games'->>'home_team' = player.nba_team THEN true WHEN line->'nba_games'->>'away_team' = player.nba_team THEN false END) AS home
    FROM jsonb_array_elements(lines) line
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('gameId', line->'id', 'nbaGameId', game->'id', 'gameDate', game->'game_date',
    'opponent', CASE WHEN home THEN 'vs ' || (game->>'away_team') WHEN home = false THEN '@ ' || (game->>'home_team')
      ELSE (game->>'away_team') || ' @ ' || (game->>'home_team') END, 'isHome', COALESCE(home, false),
    'live', replace(lower(game->>'status'), '_', '') = 'inprogress', 'didNotPlay', line->'did_not_play',
    'minutes', line->'minutes_played', 'points', COALESCE(NULLIF(line->'points', 'null'), '0'), 'rebounds', COALESCE(NULLIF(line->'rebounds', 'null'), '0'),
    'assists', COALESCE(NULLIF(line->'assists', 'null'), '0'), 'steals', COALESCE(NULLIF(line->'steals', 'null'), '0'), 'blocks', COALESCE(NULLIF(line->'blocks', 'null'), '0'),
    'turnovers', COALESCE(NULLIF(line->'turnovers', 'null'), '0'), 'personalFouls', COALESCE(NULLIF(line->'personal_fouls', 'null'), '0'),
    'fgMade', COALESCE(NULLIF(line->'field_goals_made', 'null'), '0'), 'fgAttempted', COALESCE(NULLIF(line->'field_goals_attempted', 'null'), '0'),
    'threeMade', COALESCE(NULLIF(line->'three_pointers_made', 'null'), '0'), 'threeAttempted', COALESCE(NULLIF(line->'three_pointers_attempted', 'null'), '0'),
    'ftMade', COALESCE(NULLIF(line->'free_throws_made', 'null'), '0'), 'ftAttempted', COALESCE(NULLIF(line->'free_throws_attempted', 'null'), '0'),
    'plusMinus', COALESCE(NULLIF(line->'plus_minus', 'null'), '0'), 'doubleDouble', COALESCE(NULLIF(line->'double_double', 'null'), 'false'),
    'tripleDouble', COALESCE(NULLIF(line->'triple_double', 'null'), 'false')) ORDER BY game->>'game_date' DESC, line->>'id' DESC), '[]'),
    COALESCE(jsonb_object_agg(line->>'id', CASE WHEN (line->>'did_not_play')::boolean THEN 0 ELSE public.projection_stat_fantasy_points(
      (line->>'points')::numeric,
      (line->>'rebounds')::numeric,
      (line->>'assists')::numeric,
      (line->>'steals')::numeric,
      (line->>'blocks')::numeric,
      (line->>'three_pointers_made')::numeric,
      (line->>'turnovers')::numeric,
      (line->>'field_goals_made')::numeric,
      (line->>'field_goals_attempted')::numeric,
      (line->>'free_throws_made')::numeric,
      (line->>'free_throws_attempted')::numeric,
      CASE WHEN (line->>'double_double')::boolean THEN 1 ELSE 0 END,
      CASE WHEN (line->>'triple_double')::boolean THEN 1 ELSE 0 END,
      context->'league'->'scoring_settings') END), '{}')
    INTO games, fantasy_map FROM ordered;
  IF fantasy IS NULL THEN
    SELECT COALESCE(avg((fantasy_map->>(line->>'id'))::numeric) FILTER (WHERE NOT (line->>'did_not_play')::boolean), 0) INTO fantasy
      FROM jsonb_array_elements(lines) line;
  END IF;
  RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)),
    'five_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1),
        'three_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com/points-3' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)),
    'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
      SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id
      UNION SELECT public.current_season_year_et()) years), '[]'),
    'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
      'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
      'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
      'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
      'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
      'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
      'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
    'avgFantasyPoints', fantasy, 'lines', lines, 'transactions', transactions, 'projection', projection, 'nextProjection', projection,
    'gameLog', COALESCE((SELECT jsonb_agg(game ORDER BY ordinal) FROM jsonb_array_elements(games) WITH ORDINALITY entries(game, ordinal)
      WHERE ordinal <= LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100)), '[]'),
    'hasMoreGames', jsonb_array_length(games) > LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100),
    'includesLive', EXISTS (SELECT 1 FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean),
    'liveGame', (SELECT game FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean LIMIT 1),
    'fantasyPointsMap', fantasy_map, 'selectedSeason', (context->>'seasonYear')::integer,
    'ownership', (SELECT jsonb_build_object('memberId', r.member_id, 'teamName', COALESCE(m.team_name, 'Team'), 'isOnTaxi', r.is_on_taxi) FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid AND r.player_id = player.id LIMIT 1),
    'clearsAt', (SELECT max(clears_at) FROM public.waiver_wire_log WHERE league_id = p_league_id AND player_id = player.id AND cleared_at IS NULL AND clears_at > now() AND league_season_id = (context->>'seasonId')::uuid),
    'scoringSettings', context->'league'->'scoring_settings', 'roster', public.view_roster(p_league_id, p_member_id, p_params));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_roster(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
DECLARE asset_locks jsonb; context jsonb; roster jsonb; averages jsonb; stats jsonb; slots jsonb; assignments jsonb; picks jsonb;
  target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id); transaction_state jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetKind',asset_kind,'assetId',asset_id,
    'sourceKind',source_kind,'sourceId',source_id,'reason',reason) ORDER BY source_kind,source_id), '[]'::jsonb)
    INTO asset_locks FROM private.locked_assets(p_league_id,(context->>'seasonId')::uuid,p_member_id)
    WHERE target=p_member_id;
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This roster is not available.' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='player' AND lock->>'assetId'=p.id::text),'[]'), 'id', r.id, 'is_on_ir', r.is_on_ir, 'is_on_taxi', r.is_on_taxi,
    'taxi_start_season_year', r.taxi_start_season_year, 'acquired_via', r.acquired_via, 'players', jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'nba_team', p.nba_team, 'position', p.position,
      'eligible_positions', p.eligible_positions, 'injury_status', p.injury_status, 'nba_id', p.nba_id,
      'nba_draft_number', p.nba_draft_number, 'birthdate', p.birthdate, 'years_exp', p.years_exp, 'career_regular_season_games', p.career_regular_season_games))
      ORDER BY r.is_on_taxi, r.is_on_ir), '[]'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points))
      FILTER (WHERE COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points) IS NOT NULL), '{}'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.averages, to_jsonb(source_average)))
      FILTER (WHERE COALESCE(average.averages, to_jsonb(source_average)) IS NOT NULL), '{}')
  INTO roster, averages, stats FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = p.id
      AND average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = p.id
      AND source_average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = p.id AND source_fantasy.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
  WHERE r.member_id = target AND r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  picks := COALESCE((SELECT jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='pick' AND lock->>'assetId'=pick->>'id'),'[]'), 'kind', 'pick', 'pickId', pick->'id', 'seasonYear', pick->'seasonYear',
      'round', pick->'round', 'originalTeamName', pick->'originalTeamName')) FROM jsonb_array_elements(
      public.view_picks(p_league_id, p_member_id, p_params || jsonb_build_object('targetMemberId', target))->'picks') pick), '[]');
  IF COALESCE((p_params->>'inventoryOnly')::boolean, false) THEN
    RETURN jsonb_build_object('roster', roster, 'picks', picks, 'avgMap', averages, 'avgStatsMap', stats);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slotType', slot_type, 'slotCount', slot_count)), '[]') INTO slots
    FROM public.lineup_slot_templates WHERE league_id = p_league_id;
  SELECT COALESCE(jsonb_object_agg(player_id::text, slot_type), '{}') INTO assignments FROM public.weekly_lineups
    WHERE league_id = p_league_id AND member_id = target AND league_season_id = (context->>'seasonId')::uuid
      AND game_date = COALESCE((p_params->>'date')::date, (context->>'today')::date);
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('lockedAssets', asset_locks, 'context', context, 'roster', roster,
    'picks', picks,
    'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims', 'avgMap', averages, 'avgStatsMap', stats,
    'waiverPriority', (SELECT priority FROM public.waiver_priorities WHERE member_id = p_member_id AND league_season_id = (context->>'seasonId')::uuid),
    'faabBalance', CASE WHEN context->'league'->>'waiver_mode' = 'faab' THEN transaction_state->'faabBalance' END, 'transactionState', transaction_state,
    'slotPlan', jsonb_build_object('slots', slots, 'assignments', assignments),
    'taxiExitPlayerIds', COALESCE((SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.league_member_taxi_exits
      WHERE member_id = target AND league_id = p_league_id), '[]'));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_trade_block(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; items jsonb; roster jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', item.id, 'memberId', item.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'note', item.note, 'updatedAt', item.updated_at, 'rosterLocation', CASE WHEN roster.id IS NOT NULL THEN
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END END,
    'asset', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('kind', 'player', 'playerId', player.id,
      'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position, 'eligiblePositions', player.eligible_positions,
      'nbaTeam', player.nba_team, 'nbaId', player.nba_id, 'injuryStatus', player.injury_status,
      'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number, 'careerGames', player.career_regular_season_games,
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    ELSE jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown')) END) ORDER BY item.updated_at DESC, item.id), '[]')
  INTO items FROM public.trade_block_items item JOIN public.league_members member ON member.id = item.member_id
    LEFT JOIN public.players player ON player.id = item.player_id LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id
    LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.roster_players roster ON roster.player_id = item.player_id AND roster.member_id = item.member_id
      AND roster.league_season_id = (context->>'seasonId')::uuid
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
  WHERE item.league_id = p_league_id AND (context->'season'->>'is_current')::boolean AND (player.id IS NOT NULL OR pick.id IS NOT NULL);
  IF COALESCE((p_params->>'blockOnly')::boolean, false) THEN
    RETURN jsonb_build_object('block', items);
  END IF;
  roster := public.view_roster(p_league_id, p_member_id, (p_params - 'targetMemberId') || jsonb_build_object('inventoryOnly', true));
  RETURN jsonb_build_object('context', context, 'block', items, 'items', items, 'roster', roster->'roster', 'picks', roster->'picks',
    'avgMap', roster->'avgMap', 'avgStatsMap', roster->'avgStatsMap');
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
BEGIN
  RETURN (
  WITH input_rows AS (
WITH authorized AS (
  SELECT 1
    FROM public.league_members AS own_member
   WHERE own_member.id = p_member_id
     AND own_member.league_id = p_league_id
     AND own_member.user_id = (SELECT auth.uid())
),
candidate_ids AS (
  SELECT ranking.player_id, min(ranking.source_rank) AS sort_rank
    FROM authorized
    JOIN public.dynasty_rankings AS ranking
      ON ranking.source IN (
        'hashtagbasketball.com',
        'hashtagbasketball.com/points-3',
        'hashtagbasketball.com/rookie'
      )
     AND ranking.player_id IS NOT NULL
   WHERE p_player_ids IS NULL
   GROUP BY ranking.player_id
  UNION ALL
  SELECT requested.player_id, NULL::int
    FROM authorized
    CROSS JOIN LATERAL (
      SELECT DISTINCT player_id
        FROM unnest(p_player_ids) AS ids(player_id)
    ) AS requested
   WHERE p_player_ids IS NOT NULL
),
bounded_players AS (
  SELECT
    player.id,
    COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)) AS display_name,
    player.nba_team,
    player.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(player.eligible_positions) AS pos) AS eligible_positions,
    player.injury_status,
    player.years_exp,
    player.headshot_url,
    player.nba_id,
    five_year.id AS dynasty_ranking_id,
    five_year.source_rank AS five_year_rank,
    three_year.source_rank AS three_year_rank,
    rookie.source_rank AS rookie_rank,
    five_year.rank_change,
    five_year.age,
    five_year.source AS ranking_source,
    five_year.fetched_at AS ranking_fetched_at,
    five_year.trade_value
  FROM candidate_ids AS candidate
  JOIN public.players AS player ON player.id = candidate.player_id
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS five_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/points-3'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS three_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/rookie'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS rookie ON true
  WHERE true
     OR player.display_name ILIKE '%' || trim('') || '%'
  ORDER BY candidate.sort_rank NULLS LAST, player.display_name, player.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000)
  OFFSET GREATEST(COALESCE(0, 0), 0)
),
bounded_ids AS (
  SELECT array_agg(id ORDER BY id) AS player_ids
    FROM bounded_players
),
projections AS (
  SELECT projection.*
    FROM bounded_ids AS ids
    CROSS JOIN LATERAL public.get_league_projection_rows(
      p_league_id,
      p_season_year,
      (timezone('America/New_York', now()))::date,
      'today',
      ids.player_ids,
      1000,
      0
    ) AS projection
   WHERE ids.player_ids IS NOT NULL
),
fantasy_averages AS MATERIALIZED (
  SELECT player_id, avg_fantasy_points
    FROM private.trade_value_fantasy_averages(p_league_id,p_season_year,p_player_ids)
)
SELECT
  player.id AS player_id,
  player.display_name,
  player.nba_team,
  player.position,
  player.eligible_positions,
  player.injury_status,
  player.years_exp,
  player.headshot_url,
  player.nba_id,
  player.dynasty_ranking_id,
  player.five_year_rank,
  player.three_year_rank,
  player.rookie_rank,
  player.rank_change,
  player.age,
  player.ranking_source,
  player.ranking_fetched_at,
  average.games_played,
  average.avg_points,
  average.avg_rebounds,
  average.avg_assists,
  average.avg_steals,
  average.avg_blocks,
  average.avg_three_pointers_made,
  average.avg_turnovers,
  average.avg_field_goals_made,
  average.avg_field_goals_attempted,
  average.avg_free_throws_made,
  average.avg_free_throws_attempted,
  fantasy.avg_fantasy_points,
  projection.projection_fantasy_points,
  projection.projection_fetched_at,
  projection.projection_source,
  player.trade_value
FROM bounded_players AS player
LEFT JOIN public.mv_player_season_averages AS average
  ON average.player_id = player.id
 AND average.season_year = p_season_year
LEFT JOIN fantasy_averages AS fantasy
  ON fantasy.player_id = player.id
LEFT JOIN projections AS projection ON projection.player_id = player.id
ORDER BY player.five_year_rank NULLS LAST, player.display_name, player.id
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || CASE WHEN market.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'dynasty_ranking_id', market.id,
    'five_year_rank', market.source_rank,
    'rank_change', market.rank_change,
    'age', market.age,
    'ranking_source', market.source,
    'ranking_fetched_at', market.fetched_at,
    'trade_value', market.trade_value
  ) END ORDER BY player.player_id), '[]'::jsonb)
  FROM input_rows player
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings ranking
     WHERE ranking.player_id = player.player_id AND ranking.source = 'onenumberhoops.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) market ON true);
END;
$$;
REVOKE ALL ON FUNCTION private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.trade_revaluation_input_version(p_trade_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
BEGIN
  RETURN (
  WITH context AS MATERIALIZED (
    SELECT trade.id,league.id AS league_id,season.id AS season_id,season.season_year,
      league.roster_size,league.scoring_settings,league.faab_starting_budget,
      (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams,
      queued.averages_initialized
    FROM public.trades trade JOIN public.leagues league ON league.id=trade.league_id AND league.deleted_at IS NULL
    JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id
    WHERE trade.id=p_trade_id AND trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item WHERE item.trade_id=p_trade_id
  )
  SELECT md5(jsonb_build_array('trade-inputs-v2',to_jsonb(context),
    (SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions
      WHERE scope IN ('',context.league_id::text,context.season_id::text) GROUP BY source,scope) versions),
    (SELECT jsonb_agg(jsonb_build_array(from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY id) FROM assets),
    (SELECT jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
      LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
      WHERE pick.id IN(SELECT pick_id FROM assets)),
    (SELECT jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id)
      FROM public.league_members member LEFT JOIN public.faab_balances balance
        ON balance.member_id=member.id AND balance.league_season_id=context.season_id
      WHERE member.league_id=context.league_id AND member.id IN(SELECT from_member_id FROM assets)),
    (now() AT TIME ZONE 'America/New_York')::date,
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<now()-interval '90 days'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(game_time) FROM public.nba_games WHERE game_time<=now()),
    (SELECT max(started_at) FROM public.nba_games WHERE started_at<=now())
  )::text) FROM context);
END;
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_input_version(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_trade_cards(p_league_id uuid,p_member_id uuid,p_trade_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cards jsonb; current_year integer:=public.current_season_year_et(); teams integer;
BEGIN
  PERFORM public.view_context(p_league_id,p_member_id);
  IF p_trade_ids IS NULL OR cardinality(p_trade_ids)>100 THEN
    RAISE EXCEPTION 'Choose at most 100 trades.' USING ERRCODE='22023';
  END IF;
  IF cardinality(p_trade_ids)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=p_league_id;
  WITH own_members AS MATERIALIZED (
    SELECT id FROM public.league_members WHERE league_id=p_league_id AND user_id=auth.uid()
  ), requested AS MATERIALIZED (
    SELECT id,ordinal FROM unnest(p_trade_ids) WITH ORDINALITY row(id,ordinal)
  ), chosen AS MATERIALIZED (
    SELECT trade.* FROM public.trades trade WHERE trade.league_id=p_league_id AND trade.id=ANY(p_trade_ids)
      AND (trade.status='accepted' OR trade.proposer_member_id IN(SELECT id FROM own_members)
        OR trade.recipient_member_id IN(SELECT id FROM own_members)
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=trade.id
          AND participant.member_id IN(SELECT id FROM own_members)))
  ), participants AS (
    SELECT participant.trade_id,COALESCE(jsonb_agg(jsonb_build_object('memberId',participant.member_id,
      'teamName',COALESCE(member.team_name,'Unknown'),'sortOrder',participant.sort_order,
      'isInitiator',participant.is_initiator,'acceptedAt',participant.accepted_at,
      'dropPlayerIds',participant.drop_player_ids,'rosterMoves',participant.roster_moves)
      ORDER BY participant.sort_order,member.team_name,participant.member_id),'[]') AS value
    FROM chosen trade JOIN public.trade_participants participant ON participant.trade_id=trade.id
    LEFT JOIN public.league_members member ON member.id=participant.member_id AND member.league_id=p_league_id
    GROUP BY participant.trade_id
  ), pick_values AS MATERIALIZED (
    SELECT value.* FROM public.get_dynasty_pick_values(p_league_id) value
    WHERE EXISTS(SELECT 1 FROM chosen trade JOIN public.trade_items item ON item.trade_id=trade.id
      JOIN public.draft_picks pick ON pick.id=item.pick_id WHERE pick.predicted_trade_value IS NULL)
  ), items AS (
    SELECT item.trade_id, COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM pick_values value
        WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
    AS value FROM public.trade_items item JOIN chosen trade ON trade.id=item.trade_id LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id AND pick.league_id=p_league_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id AND original.league_id=p_league_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = current_year
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = current_year
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = current_year
    GROUP BY item.trade_id

  )
  SELECT COALESCE(jsonb_agg(CASE WHEN trade.id IS NOT NULL THEN jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', COALESCE(participants.value,'[]'::jsonb), 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', COALESCE(items.value,'[]'::jsonb), 'estimate', CASE WHEN quote.id IS NOT NULL THEN jsonb_build_object('quoteId',quote.id,'modelVersion',quote.model_version,'inputVersion',quote.input_version,'createdAt',quote.created_at,'teams',quote.analysis->'teams','assets',quote.analysis->'assets') END, 'estimateUnavailable', recorded.unavailable_reason) END ORDER BY requested.ordinal),'[]')
  INTO cards FROM requested LEFT JOIN chosen trade ON trade.id=requested.id
    LEFT JOIN participants ON participants.trade_id=trade.id LEFT JOIN items ON items.trade_id=trade.id
    LEFT JOIN public.trade_estimates recorded ON recorded.trade_id=trade.id
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id;
  RETURN cards;
END;
$$;
REVOKE ALL ON FUNCTION public.get_trade_cards(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_trade_cards(uuid,uuid,uuid[]) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.view_trades(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; refs jsonb; rows jsonb; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 40), 1), 99);
  has_more boolean; next_cursor jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF COALESCE(p_params->>'tab', 'offers') = 'history' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM (
      SELECT trade.id AS trade_id, jsonb_build_object('proposedAt', trade.proposed_at, 'tradeId', trade.id)::text AS cursor_token
      FROM public.trade_participants participant JOIN public.trades trade ON trade.id = participant.trade_id
      WHERE participant.league_id = p_league_id AND participant.member_id = p_member_id AND trade.status <> 'pending'
        AND (p_params->>'cursor' IS NULL OR (trade.proposed_at, trade.id) < (
          ((p_params->>'cursor')::jsonb->>'proposedAt')::timestamptz, ((p_params->>'cursor')::jsonb->>'tradeId')::uuid))
      ORDER BY participant.proposed_at DESC, participant.trade_id DESC LIMIT page_size + 1) ref;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM public.get_trade_page_refs(p_member_id, p_league_id, page_size + 1, p_params->>'cursor') ref;
  END IF;
  has_more := jsonb_array_length(refs) > page_size;
  IF jsonb_array_length(refs)=0 THEN rows:='[]'::jsonb;
  ELSE
  rows := public.get_trade_cards(p_league_id,p_member_id,ARRAY(
    SELECT (ref->>'trade_id')::uuid FROM jsonb_array_elements(refs) WITH ORDINALITY refs(ref,ordinal)
    WHERE ordinal<=page_size ORDER BY ordinal));
  END IF;
  IF has_more THEN next_cursor := jsonb_build_object('token', refs->(page_size - 1)->>'cursor_token'); END IF;
  RETURN jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'block', public.view_trade_block(p_league_id, p_member_id, p_params || jsonb_build_object('blockOnly', true))->'block',
    'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'team_name', team_name, 'role', role) ORDER BY id)
      FROM public.league_members WHERE league_id = p_league_id), '[]'));
END;
$$;

NOTIFY pgrst,'reload schema';
COMMIT;
