CREATE OR REPLACE FUNCTION private.league_version_enqueue(p_league_id uuid,p_topic text,p_source text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(p_league_id,p_topic,p_source);
    RETURN;
  END IF;
  INSERT INTO private.league_version_pending AS pending(transaction_id,league_id,topics,sources)
    VALUES(pg_current_xact_id(),p_league_id,ARRAY[p_topic],ARRAY[p_source])
  ON CONFLICT(transaction_id,league_id) DO UPDATE SET
    topics=ARRAY(SELECT DISTINCT unnest(pending.topics||EXCLUDED.topics) ORDER BY 1),
    sources=ARRAY(SELECT DISTINCT unnest(pending.sources||EXCLUDED.sources) ORDER BY 1)
  WHERE NOT pending.topics @> EXCLUDED.topics OR NOT pending.sources @> EXCLUDED.sources;
END;
$$;
