-- Canonical SQL source for private.update_forecast_season_points.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.update_forecast_season_points()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    DELETE FROM private.forecast_season_points;
  ELSIF TG_OP='DELETE' THEN
    DELETE FROM private.forecast_season_points p USING forecast_old o
      WHERE p.player_id=o.player_id AND p.season_year=o.season_year;
  ELSE
    UPDATE private.forecast_season_points p SET scoring_hash=md5(l.scoring_settings::text),source_revision=t.xmin::text,
      fantasy_points=public.projection_stat_fantasy_points(a.avg_points,a.avg_rebounds,a.avg_assists,a.avg_steals,a.avg_blocks,
        a.avg_three_pointers_made,a.avg_turnovers,a.avg_field_goals_made,a.avg_field_goals_attempted,
        a.avg_free_throws_made,a.avg_free_throws_attempted,
        CASE WHEN a.games_played>0 THEN a.double_doubles::numeric/a.games_played ELSE 0 END,
        CASE WHEN a.games_played>0 THEN a.triple_doubles::numeric/a.games_played ELSE 0 END,l.scoring_settings)
    FROM public.mv_player_season_averages a JOIN forecast_new n USING(player_id,season_year)
      JOIN analytics.player_season_totals t USING(player_id,season_year),public.leagues l
    WHERE p.player_id=a.player_id AND p.season_year=a.season_year AND l.id=p.league_id;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection';
  ELSIF TG_OP='INSERT' THEN
    IF EXISTS(SELECT 1 FROM forecast_new) THEN UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection'; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM forecast_old) THEN UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
