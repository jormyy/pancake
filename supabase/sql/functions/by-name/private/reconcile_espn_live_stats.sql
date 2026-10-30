-- Canonical SQL source for private.reconcile_espn_live_stats.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.reconcile_espn_live_stats(p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_players uuid[]; v_removed jsonb; v_started_at timestamptz := clock_timestamp();
BEGIN
  IF current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'An official NBA snapshot is required.' USING ERRCODE='PT409';
  END IF;
  SELECT espn_only_player_ids INTO v_players FROM private.live_feed_state WHERE game_id=p_game_id;
  IF coalesce(cardinality(v_players),0)=0 THEN RETURN; END IF;
  WITH removed AS (
    DELETE FROM public.player_game_stats WHERE game_id=p_game_id AND player_id=ANY(v_players) RETURNING *
  ) SELECT coalesce(jsonb_agg(to_jsonb(removed)),'[]'::jsonb) INTO v_removed FROM removed;
  IF jsonb_array_length(v_removed)>0 THEN
    INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,rows_affected,details)
      VALUES('sync-stats:espn-live-reconcile',v_started_at,clock_timestamp(),'success',jsonb_array_length(v_removed),
        jsonb_build_object('game_id',p_game_id,'source','espn','removed_provisional_rows',v_removed));
  END IF;
  UPDATE private.live_feed_state SET espn_only_player_ids='{}' WHERE game_id=p_game_id;
END;
$$;
