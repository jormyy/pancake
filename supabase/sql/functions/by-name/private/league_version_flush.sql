CREATE OR REPLACE FUNCTION private.league_version_flush()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE pending record;
BEGIN
  FOR pending IN SELECT transaction_id,league_id,topics,sources FROM private.league_version_pending
    WHERE transaction_id=pg_current_xact_id() ORDER BY league_id LOOP
    BEGIN
      PERFORM private.publish_league_version(pending.league_id,pending.topics,pending.sources);
      DELETE FROM private.league_version_pending
        WHERE transaction_id=pending.transaction_id AND league_id=pending.league_id;
    EXCEPTION WHEN serialization_failure THEN
      IF NOT pending.sources <@ ARRAY['faab_balances']::text[] THEN RAISE; END IF;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
