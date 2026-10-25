-- Canonical SQL source for private.flush_player_stats_hints.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.flush_player_stats_hints()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT pending.league_id FROM private.player_stats_hint_pending pending
    WHERE NOT EXISTS(SELECT 1 FROM public.league_change_hints hint
      WHERE hint.league_id=pending.league_id AND hint.topic='score'
        AND hint.updated_at>clock_timestamp()-interval '1 minute')
    ORDER BY pending.league_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), emitted AS (
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details,updated_at)
    SELECT ready.league_id,'score',1,NULL,NULL,clock_timestamp() FROM ready
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=NULL,updated_at=clock_timestamp()
    WHERE stored.updated_at<=clock_timestamp()-interval '1 minute'
    RETURNING league_id
  ) DELETE FROM private.player_stats_hint_pending WHERE league_id IN (SELECT league_id FROM emitted);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;
