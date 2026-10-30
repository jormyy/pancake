-- Canonical SQL source for public.prepare_matchup_forecast_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prepare_matchup_forecast_inputs(p_matchup_id uuid,p_game_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record; v_ids uuid[]; v_missing uuid[]; v_roster_hash text; v_history_revision bigint;
  v_projection_revision bigint; v_dates date[]; v_game_date date; v_rows jsonb; v_expires timestamptz;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,s.season_year,
    w.week_start,e.week_end,l.scoring_settings,md5(l.scoring_settings::text) AS scoring_hash INTO c
  FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.leagues l ON l.id=m.league_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(array_agg(player_id ORDER BY player_id),'{}'::uuid[]),
    md5(COALESCE(string_agg(player_id::text,',' ORDER BY player_id),'')) INTO v_ids,v_roster_hash
  FROM public.roster_players WHERE league_id=c.league_id AND league_season_id=c.league_season_id
    AND member_id IN(c.home_member_id,c.away_member_id);
  SELECT revision INTO STRICT v_history_revision FROM private.forecast_input_revisions WHERE kind='history';
  SELECT revision INTO STRICT v_projection_revision FROM private.forecast_input_revisions WHERE kind='projection';
  SELECT COALESCE(array_agg(DISTINCT g.game_date ORDER BY g.game_date),'{}'::date[]) INTO v_dates
  FROM public.nba_games g WHERE g.season_year=c.season_year
    AND g.game_date BETWEEN GREATEST(c.week_start,v_today) AND c.week_end
    AND public.is_regular_season_game_id(g.nba_game_id) AND g.status NOT IN('Final','Postponed','Cancelled');
  IF p_game_date IS NULL THEN
    INSERT INTO private.forecast_season_points AS stored(league_id,season_year,player_id,scoring_hash,source_revision,fantasy_points)
    SELECT c.league_id,c.season_year,a.player_id,c.scoring_hash,t.xmin::text,
      public.projection_stat_fantasy_points(a.avg_points,a.avg_rebounds,a.avg_assists,a.avg_steals,a.avg_blocks,
        a.avg_three_pointers_made,a.avg_turnovers,a.avg_field_goals_made,a.avg_field_goals_attempted,
        a.avg_free_throws_made,a.avg_free_throws_attempted,
        CASE WHEN a.games_played>0 THEN a.double_doubles::numeric/a.games_played ELSE 0 END,
        CASE WHEN a.games_played>0 THEN a.triple_doubles::numeric/a.games_played ELSE 0 END,c.scoring_settings)
    FROM public.mv_player_season_averages a JOIN analytics.player_season_totals t USING(player_id,season_year)
    LEFT JOIN private.forecast_season_points existing ON existing.league_id=c.league_id
      AND existing.season_year=a.season_year AND existing.player_id=a.player_id
    WHERE a.player_id=ANY(v_ids) AND a.season_year=c.season_year
      AND (existing.player_id IS NULL OR existing.scoring_hash IS DISTINCT FROM c.scoring_hash OR existing.source_revision IS DISTINCT FROM t.xmin::text)
    ORDER BY a.player_id
    ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET scoring_hash=EXCLUDED.scoring_hash,
      source_revision=EXCLUDED.source_revision,fantasy_points=EXCLUDED.fantasy_points;
    SELECT array_agg(r.player_id) INTO v_missing FROM unnest(v_ids) r(player_id)
    LEFT JOIN private.forecast_player_history h ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
    WHERE h.player_id IS NULL OR h.observed_date<>v_today OR h.revision<>v_history_revision OR h.scoring_hash<>c.scoring_hash;
    IF cardinality(v_missing)>0 THEN
      INSERT INTO private.forecast_player_history(league_id,season_year,player_id,observed_date,revision,scoring_hash,scores)
      SELECT c.league_id,c.season_year,r.player_id,v_today,v_history_revision,c.scoring_hash,
        (SELECT array_agg(public.projection_stat_fantasy_points(h.points,h.rebounds,h.assists,h.steals,h.blocks,
          h.three_pointers_made,h.turnovers,h.field_goals_made,h.field_goals_attempted,h.free_throws_made,h.free_throws_attempted,
          CASE WHEN h.double_double THEN 1 ELSE 0 END,CASE WHEN h.triple_double THEN 1 ELSE 0 END,c.scoring_settings)
          ORDER BY h.game_date,h.id) FROM (
            SELECT s.* FROM public.player_game_stats s
            WHERE s.player_id=r.player_id AND NOT s.did_not_play
              AND s.game_date<v_today AND s.season_year BETWEEN c.season_year-1 AND c.season_year
              AND (SELECT g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)
                FROM public.nba_games g WHERE g.id=s.game_id)
            ORDER BY s.game_date DESC,s.id LIMIT 30
          ) h)
      FROM unnest(v_missing) r(player_id)
      ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET observed_date=EXCLUDED.observed_date,
        revision=EXCLUDED.revision,scoring_hash=EXCLUDED.scoring_hash,scores=EXCLUDED.scores;
    END IF;
    DELETE FROM private.forecast_projection_inputs p WHERE p.matchup_id=p_matchup_id AND p.game_date<v_today;
  END IF;
  SELECT COALESCE(array_agg(d.game_date ORDER BY d.game_date),'{}'::date[]) INTO v_dates
  FROM unnest(v_dates) d(game_date)
  LEFT JOIN private.forecast_projection_inputs p ON p.matchup_id=p_matchup_id AND p.game_date=d.game_date
  WHERE (p_game_date IS NULL OR d.game_date=p_game_date)
    AND (p.matchup_id IS NULL OR p.observed_date<>v_today OR p.revision<>v_projection_revision
      OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>v_roster_hash OR p.valid_until<=now());
  IF cardinality(v_dates)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT LEAST((v_today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.game_time>now()),
    (SELECT min(g.started_at) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.started_at>now()),
    (SELECT min(r.fetched_at+interval '36 hours') FROM public.sleeper_projection_rows r WHERE r.player_id=ANY(v_ids) AND r.fetched_at+interval '36 hours'>now()),
    (SELECT min(r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END)
      FROM public.fantasypros_projection_rows r WHERE r.player_id=ANY(v_ids)
        AND r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END>now())) INTO v_expires;
  FOREACH v_game_date IN ARRAY v_dates LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object('requested_date',v_game_date,'player_id',p.player_id,
      'projection_fantasy_points',p.projection_fantasy_points,'projection_source_label',p.projection_source_label,
      'projection_fetched_at',p.projection_fetched_at,'projection_date',p.projection_date,
      'projection_is_fresh',p.projection_is_fresh) ORDER BY p.player_id),'[]'::jsonb) INTO v_rows
    FROM public.get_league_projection_rows(c.league_id,c.season_year,v_game_date,'today',v_ids,100,0) p;
    INSERT INTO private.forecast_projection_inputs AS stored(matchup_id,game_date,observed_date,revision,scoring_hash,roster_hash,valid_until,rows)
      VALUES(p_matchup_id,v_game_date,v_today,v_projection_revision,c.scoring_hash,v_roster_hash,v_expires,v_rows)
    ON CONFLICT(matchup_id,game_date) DO UPDATE SET observed_date=EXCLUDED.observed_date,revision=EXCLUDED.revision,
      scoring_hash=EXCLUDED.scoring_hash,roster_hash=EXCLUDED.roster_hash,valid_until=EXCLUDED.valid_until,rows=EXCLUDED.rows
      WHERE ROW(stored.observed_date,stored.revision,stored.scoring_hash,stored.roster_hash,stored.valid_until,stored.rows)
        IS DISTINCT FROM ROW(EXCLUDED.observed_date,EXCLUDED.revision,EXCLUDED.scoring_hash,EXCLUDED.roster_hash,EXCLUDED.valid_until,EXCLUDED.rows);
  END LOOP;
  RETURN '[]'::jsonb;
END;
$$;
