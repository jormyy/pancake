-- Canonical SQL source for private.reconcile_missing_final_stats.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_missing_final_stats(p_now timestamptz DEFAULT now(),p_before_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' SET statement_timeout='3s'
AS $$
DECLARE dates date[]; day date; jobs jsonb:='[]'; today date:=(p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF p_now IS NULL THEN RAISE EXCEPTION 'Reconciliation time is required'; END IF;
  SELECT array_agg(missing.game_date ORDER BY missing.game_date DESC) INTO dates
  FROM (
    SELECT DISTINCT game.game_date FROM public.nba_games game
    WHERE game.status='Final' AND public.is_regular_season_game_id(game.nba_game_id)
      AND game.game_date<=today AND (p_before_date IS NULL OR game.game_date<p_before_date)
      AND NOT EXISTS(SELECT 1 FROM public.player_game_stats stats WHERE stats.game_id=game.id)
    ORDER BY game.game_date DESC LIMIT 16
  ) missing;
  FOREACH day IN ARRAY coalesce(dates,'{}'::date[]) LOOP
    jobs:=jobs||jsonb_build_array(public.create_or_resume_stats_sync_job_atomic(day,day));
  END LOOP;
  IF cardinality(dates)=16 THEN
    PERFORM private.work_enqueue('missing-final-stats',today::text||':'||dates[16]::text,p_now,
      jsonb_build_object('beforeDate',dates[16]));
  END IF;
  IF cardinality(dates)>0 THEN PERFORM private.enqueue_stats_sync_dispatch(p_now); END IF;
  RETURN jsonb_build_object('dates',coalesce(to_jsonb(dates),'[]'::jsonb),'jobs',jobs);
END;
$$;
