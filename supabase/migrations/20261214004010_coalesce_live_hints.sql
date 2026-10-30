BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

CREATE UNLOGGED TABLE private.live_hint_broadcasts (
  transaction_id xid8 NOT NULL,
  topic text NOT NULL,
  changes jsonb NOT NULL,
  deferred boolean NOT NULL DEFAULT false,
  PRIMARY KEY(transaction_id,topic)
);
REVOKE ALL ON private.live_hint_broadcasts FROM PUBLIC,anon,authenticated;

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

CREATE OR REPLACE FUNCTION private.broadcast_live_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_row jsonb:='{}'; previous_row jsonb:='{}'; payload jsonb; target text; targets text[]:=ARRAY[]::text[];
  row_data jsonb; league_id uuid; draft_id uuid; new_data jsonb:='{}'; old_data jsonb:='{}';
BEGIN
  IF TG_OP<>'DELETE' THEN current_row:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN previous_row:=to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='league_change_hints' THEN
    new_data:=current_row;
    IF TG_OP='DELETE' THEN old_data:=previous_row; END IF;
  ELSIF TG_TABLE_NAME='roster_players' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('member_id',current_row->'member_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('member_id',previous_row->'member_id'));
  ELSIF TG_TABLE_NAME='matchup_forecasts' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',current_row->'matchup_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',previous_row->'matchup_id'));
  END IF;
  payload:=jsonb_build_object('schema','public','table',TG_TABLE_NAME,'eventType',TG_OP,
    'commit_timestamp',clock_timestamp(),'new',new_data,'old',old_data,'errors','[]'::jsonb);
  FOREACH row_data IN ARRAY ARRAY[current_row,previous_row] LOOP
    IF row_data='{}'::jsonb THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='waiver_claims' THEN
      targets:=array_append(targets,'l1:member:'||(row_data->>'member_id'));
      CONTINUE;
    END IF;
    league_id:=NULL; draft_id:=NULL;
    IF TG_TABLE_NAME='leagues' THEN league_id:=(row_data->>'id')::uuid;
    ELSE league_id:=(row_data->>'league_id')::uuid; END IF;
    IF TG_TABLE_NAME='drafts' THEN draft_id:=(row_data->>'id')::uuid;
    ELSIF TG_TABLE_NAME IN ('draft_budgets','nominations','snake_draft_picks') THEN draft_id:=(row_data->>'draft_id')::uuid; END IF;
    IF draft_id IS NOT NULL THEN
      targets:=array_append(targets,'l1:draft:'||draft_id::text);
      IF league_id IS NULL THEN SELECT draft.league_id INTO league_id FROM public.drafts draft WHERE draft.id=draft_id; END IF;
    END IF;
    IF league_id IS NOT NULL THEN targets:=array_append(targets,'l1:league:'||league_id::text); END IF;
    IF TG_TABLE_NAME='league_members' THEN targets:=array_append(targets,'l1:user:'||(row_data->>'user_id')); END IF;
  END LOOP;
  FOR target IN SELECT DISTINCT value FROM unnest(targets) value WHERE value IS NOT NULL ORDER BY value LOOP
    IF TG_TABLE_NAME='league_change_hints' THEN
      row_data:=CASE WHEN TG_OP='DELETE' THEN previous_row ELSE current_row END;
      IF target='l1:league:'||(row_data->>'league_id') THEN row_data:=row_data-'league_id'; END IF;
      INSERT INTO private.live_hint_broadcasts AS pending(transaction_id,topic,changes)
        VALUES(pg_current_xact_id(),target,jsonb_build_array(jsonb_build_object('event',TG_OP,
          'row',row_data)))
      ON CONFLICT(transaction_id,topic) DO UPDATE SET changes=pending.changes||EXCLUDED.changes;
    ELSE
      PERFORM realtime.send(payload,'change',target,true);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.flush_live_hint_broadcasts() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER flush_live_hint_broadcasts
  AFTER INSERT OR UPDATE ON private.live_hint_broadcasts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.flush_live_hint_broadcasts();
COMMIT;
