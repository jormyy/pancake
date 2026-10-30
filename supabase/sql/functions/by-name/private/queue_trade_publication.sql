-- Canonical SQL source for private.queue_trade_publication.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.queue_trade_publication(p_league_id uuid,p_topic text DEFAULT 'trade',p_source text DEFAULT 'trades',p_event jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE publication uuid;
BEGIN
  INSERT INTO private.trade_publications AS queued(transaction_id,league_id,topics,sources,events)
    VALUES(pg_current_xact_id(),p_league_id,ARRAY[p_topic],ARRAY[p_source],
      CASE WHEN p_event IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_event) END)
  ON CONFLICT(transaction_id,league_id) DO UPDATE SET
    topics=ARRAY(SELECT DISTINCT unnest(queued.topics||EXCLUDED.topics) ORDER BY 1),
    sources=ARRAY(SELECT DISTINCT unnest(queued.sources||EXCLUDED.sources) ORDER BY 1),
    events=queued.events||EXCLUDED.events
  RETURNING id INTO publication;
  PERFORM private.work_enqueue('trade-publication',publication::text,now(),jsonb_build_object('publicationId',publication));
END;
$$;
