-- Canonical SQL source for public.save_final_game_snapshot_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_final_game_snapshot_atomic(
  p_game_id uuid, p_provider_game_id text, p_stats jsonb, p_source_updated_at timestamptz,
  p_home_score integer, p_away_score integer, p_status_text text
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_year integer; v_game public.nba_games%ROWTYPE; v_revision timestamptz;
  v_previous_context text; v_changed integer;
BEGIN
  IF p_source_updated_at IS NULL OR NOT isfinite(p_source_updated_at)
    OR p_source_updated_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'A valid source revision time is required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  SELECT revision_at INTO v_revision FROM private.game_stat_revisions WHERE game_id=p_game_id;
  IF v_revision IS NOT NULL AND p_source_updated_at<=v_revision THEN
    UPDATE public.nba_games SET stats_synced_at=clock_timestamp() WHERE id=p_game_id;
    RETURN 0;
  END IF;
  v_previous_context:=current_setting('app.verified_stats_game',true);
  PERFORM set_config('app.verified_stats_game',p_game_id::text,true);
  PERFORM public.save_live_scoreboard_atomic(p_game_id,p_provider_game_id,'Final',p_home_score,p_away_score,p_status_text,0);
  v_changed:=public.save_game_stats_atomic(p_game_id,p_provider_game_id,p_stats,true);
  INSERT INTO private.game_stat_revisions(game_id,revision_at) VALUES(p_game_id,p_source_updated_at)
    ON CONFLICT(game_id) DO UPDATE SET revision_at=EXCLUDED.revision_at;
  PERFORM set_config('app.verified_stats_game',coalesce(v_previous_context,''),true);
  RETURN v_changed;
END;
$$;
