CREATE OR REPLACE FUNCTION private.flush_live_hint_broadcasts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changes jsonb; batch jsonb;
BEGIN
  IF NOT NEW.deferred AND EXISTS(SELECT 1 FROM private.league_version_pending
    WHERE transaction_id=NEW.transaction_id AND league_id=split_part(NEW.topic,':',3)::uuid) THEN
    UPDATE private.live_hint_broadcasts SET deferred=true
      WHERE transaction_id=NEW.transaction_id AND topic=NEW.topic AND NOT deferred;
    RETURN NULL;
  END IF;
  DELETE FROM private.live_hint_broadcasts pending
    WHERE pending.transaction_id=NEW.transaction_id AND pending.topic=NEW.topic
    RETURNING pending.changes INTO changes;
  FOR batch IN SELECT jsonb_agg(value ORDER BY ordinality)
    FROM jsonb_array_elements(changes) WITH ORDINALITY GROUP BY (ordinality-1)/32 ORDER BY (ordinality-1)/32 LOOP
    PERFORM realtime.send(jsonb_build_object('hints',batch),'change',NEW.topic,true);
  END LOOP;
  RETURN NULL;
END;
$$;
