SET lock_timeout='3s';
SET statement_timeout='2min';
SET search_path=pg_catalog;
DO $$
DECLARE target record; original regclass; index_defs text[]; foreign_defs text[]; trigger_defs text[]; policy_defs text[]; grants jsonb;
  sequence_grants jsonb; trigger_states jsonb; trigger_state record; sequence_name text; sequence_last bigint; sequence_called boolean; new_sequence text; column_names text;
  month_start date; month_end date; owner_name text; original_rls boolean; original_force boolean; definition text; privilege record;
BEGIN
  FOR target IN SELECT schema_name,table_name,time_column,identity_column FROM (VALUES ('public','notification_outbox','created_at','id')) AS targets(schema_name,table_name,time_column,identity_column) LOOP
    original:=format('%I.%I',target.schema_name,target.table_name)::regclass;
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',original);
    IF (SELECT relkind FROM pg_class WHERE oid=original)='p' THEN
      IF NOT EXISTS(SELECT FROM private.partitioned_log_policies WHERE parent_table=original AND time_column=target.time_column AND identity_column=target.identity_column) THEN
        RAISE EXCEPTION 'Existing partition policy differs for %',original;
      END IF;
      CONTINUE;
    END IF;
    SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity INTO owner_name,original_rls,original_force FROM pg_class WHERE oid=original;
    SELECT array_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid) INTO index_defs FROM pg_index WHERE indrelid=original AND NOT indisprimary;
    SELECT array_agg('ADD CONSTRAINT '||quote_ident(conname)||' '||pg_get_constraintdef(oid)) INTO foreign_defs FROM pg_constraint WHERE conrelid=original AND contype='f';
    SELECT array_agg(pg_get_triggerdef(oid) ORDER BY tgname) INTO trigger_defs FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
    SELECT jsonb_object_agg(tgname,tgenabled) INTO trigger_states FROM pg_trigger WHERE tgrelid=original AND NOT tgisinternal;
    SELECT array_agg(format('CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s',polname,original,
      CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      (SELECT string_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END,',') FROM unnest(polroles) role_id),
      CASE WHEN polqual IS NULL THEN '' ELSE ' USING ('||pg_get_expr(polqual,polrelid)||')' END,
      CASE WHEN polwithcheck IS NULL THEN '' ELSE ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' END))
      INTO policy_defs FROM pg_policy WHERE polrelid=original;
    SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO grants
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=original;
    sequence_name:=pg_get_serial_sequence(original::text,target.identity_column);
    IF sequence_name IS NOT NULL THEN
      EXECUTE format('SELECT last_value,is_called FROM %s',sequence_name) INTO sequence_last,sequence_called;
      SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)) INTO sequence_grants
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=sequence_name::regclass;
    END IF;
    EXECUTE format('SELECT coalesce(date_trunc(''month'',min(%I) AT TIME ZONE ''UTC'')::date,date_trunc(''month'',now() AT TIME ZONE ''UTC'')::date),greatest(coalesce(date_trunc(''month'',max(%I) AT TIME ZONE ''UTC'')::date,current_date),(date_trunc(''month'',now() AT TIME ZONE ''UTC'')+interval ''2 months'')::date) FROM %s',target.time_column,target.time_column,original) INTO month_start,month_end;
    EXECUTE format('ALTER TABLE %s RENAME TO %I',original,target.table_name||'_unpartitioned');
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL EXCLUDING INDEXES) PARTITION BY RANGE (%I)',target.schema_name,target.table_name,target.schema_name,target.table_name||'_unpartitioned',target.time_column);
    original:=format('%I.%I',target.schema_name,target.table_name)::regclass;
    EXECUTE format('ALTER TABLE %s OWNER TO %I',original,owner_name);
    INSERT INTO private.partitioned_log_policies VALUES(original,target.time_column,target.identity_column);
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s DEFAULT WITH (fillfactor=90,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.05,autovacuum_vacuum_threshold=50,autovacuum_analyze_threshold=50)',target.schema_name,target.table_name||'_default',original);
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',target.schema_name,target.table_name||'_default',owner_name);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',target.schema_name,target.table_name||'_default');
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC,anon,authenticated,service_role',target.schema_name,target.table_name||'_default');
    WHILE month_start<=month_end LOOP
      PERFORM private.ensure_log_partition(original,month_start);
      month_start:=(month_start+interval '1 month')::date;
    END LOOP;
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO column_names FROM pg_attribute WHERE attrelid=original AND attnum>0 AND NOT attisdropped;
    EXECUTE format('INSERT INTO %s(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM %I.%I',original,column_names,column_names,target.schema_name,target.table_name||'_unpartitioned');
    EXECUTE format('DROP TABLE %I.%I',target.schema_name,target.table_name||'_unpartitioned');
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I PRIMARY KEY (%I,%I)',original,target.table_name||'_pkey',target.identity_column,target.time_column);
    FOREACH definition IN ARRAY coalesce(index_defs,'{}') LOOP
      IF definition LIKE 'CREATE UNIQUE INDEX %' THEN
        definition:=replace(replace(definition,'(dedupe_key)','(dedupe_key, created_at)'),'(expo_ticket_id)','(expo_ticket_id, created_at)');
      END IF;
      EXECUTE definition;
    END LOOP;
    FOREACH definition IN ARRAY coalesce(policy_defs,'{}') LOOP EXECUTE definition; END LOOP;
    FOREACH definition IN ARRAY coalesce(foreign_defs,'{}') LOOP EXECUTE format('ALTER TABLE %s %s',original,definition); END LOOP;
    FOREACH definition IN ARRAY coalesce(trigger_defs,'{}') LOOP EXECUTE definition; END LOOP;
    FOR trigger_state IN SELECT key AS name,value AS enabled FROM jsonb_each_text(trigger_states) LOOP
      EXECUTE format('ALTER TABLE %s %s TRIGGER %I',original,CASE trigger_state.enabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END,trigger_state.name);
    END LOOP;
    EXECUTE format('ALTER TABLE %s OWNER TO %I',original,owner_name);
    IF original_rls THEN EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',original); END IF;
    IF original_force THEN EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',original); END IF;
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC,anon,authenticated,service_role',original);
    FOR privilege IN SELECT a.role,a.privilege,a.grantable FROM jsonb_to_recordset(grants) AS a(role text,privilege text,grantable boolean) LOOP
      EXECUTE format('GRANT %s ON %s TO %s%s',privilege.privilege,original,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    IF sequence_name IS NOT NULL THEN
      new_sequence:=pg_get_serial_sequence(original::text,target.identity_column);
      PERFORM setval(new_sequence,sequence_last,sequence_called);
      EXECUTE format('ALTER SEQUENCE %s RENAME TO %I',new_sequence,target.table_name||'_'||target.identity_column||'_seq');
      new_sequence:=pg_get_serial_sequence(original::text,target.identity_column);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,anon,authenticated,service_role',new_sequence);
      FOR privilege IN SELECT a.role,a.privilege,a.grantable FROM jsonb_to_recordset(sequence_grants) AS a(role text,privilege text,grantable boolean) LOOP
        EXECUTE format('GRANT %s ON SEQUENCE %s TO %s%s',privilege.privilege,new_sequence,CASE WHEN privilege.role='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(privilege.role) END,CASE WHEN privilege.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;

  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_partition_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identity_value text; present boolean;
BEGIN
  identity_value:=to_jsonb(NEW)->>TG_ARGV[1];
  IF identity_value IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND identity_value IS NOT DISTINCT FROM to_jsonb(OLD)->>TG_ARGV[1] THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
    RAISE EXCEPTION 'Partition identity writes require READ COMMITTED' USING ERRCODE='0A000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0]||':'||identity_value,48191));
  EXECUTE format('SELECT EXISTS(SELECT FROM %s stored WHERE stored.%I=($1).%I)',TG_ARGV[0]::regclass,TG_ARGV[1],TG_ARGV[1])
    INTO present USING NEW;
  IF present THEN
    RAISE unique_violation USING MESSAGE='Duplicate partitioned identity',CONSTRAINT=TG_ARGV[2];
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_outbox_global_id BEFORE INSERT OR UPDATE OF id ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity('public.notification_outbox','id','notification_outbox_pkey');
CREATE TRIGGER notification_outbox_global_dedupe_key BEFORE INSERT OR UPDATE OF dedupe_key ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity('public.notification_outbox','dedupe_key','notification_outbox_dedupe_key_key');
CREATE TRIGGER notification_outbox_global_expo_ticket_id BEFORE INSERT OR UPDATE OF expo_ticket_id ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION private.guard_partition_identity('public.notification_outbox','expo_ticket_id','notification_outbox_expo_ticket_id_key');
RESET search_path;
CREATE OR REPLACE FUNCTION private.enqueue_notifications(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' SET statement_timeout='3s' AS $$
DECLARE dedupe text; inserted integer;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>1000 THEN
    RAISE EXCEPTION 'At most 1000 notification rows are required' USING ERRCODE='22023';
  END IF;
  FOR dedupe IN SELECT DISTINCT row->>'dedupe_key' FROM jsonb_array_elements(p_rows) row ORDER BY 1 LOOP
    IF dedupe IS NULL THEN RAISE EXCEPTION 'A notification dedupe key is required' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('public.notification_outbox:'||dedupe,48191));
  END LOOP;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT DISTINCT ON (incoming.dedupe_key) incoming.dedupe_key,incoming.member_id,incoming.event_type,incoming.title,incoming.body,incoming.data,incoming.category
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY item(payload,position)
  CROSS JOIN LATERAL jsonb_to_record(item.payload) incoming(dedupe_key text,member_id uuid,event_type text,title text,body text,data jsonb,category text)
  WHERE NOT EXISTS(SELECT FROM public.notification_outbox stored WHERE stored.dedupe_key=incoming.dedupe_key)
  ORDER BY incoming.dedupe_key,item.position;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  RETURN inserted;
END;
$$;
CREATE OR REPLACE FUNCTION public.enqueue_rookie_pick_notification(p_draft_id uuid,p_member_id uuid,p_player_id uuid,p_pick_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' SET statement_timeout='3s' AS $$
BEGIN
  PERFORM private.enqueue_notifications(jsonb_build_array(jsonb_build_object(
    'dedupe_key','rookie-pick:'||p_pick_id::text||':'||p_member_id::text,
    'member_id',p_member_id,'event_type','rookie_draft_pick','title','Rookie Draft Pick Made',
    'body','A player has been added to your roster.',
    'data',jsonb_build_object('draftId',p_draft_id,'playerId',p_player_id,'pickId',p_pick_id),'category','draft')));
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notifications_queued integer;
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_cancel_claims boolean;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
BEGIN
  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  -- An old-season row going away never touches live state.
  IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id = OLD.league_season_id AND is_current = true) THEN
    RETURN NULL;
  END IF;


  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  IF v_left_roster THEN
    DELETE FROM trade_block_items
     WHERE league_id = OLD.league_id
       AND member_id = OLD.member_id
       AND player_id = OLD.player_id;

    v_cancel_claims := private.trade_lifecycle_write_active()
      AND EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades);
    IF v_cancel_claims THEN
      WITH changed_claims AS (
        UPDATE waiver_claims
           SET status = 'cancelled',
               failure_reason = 'The selected drop player left this roster in another transaction.',
               processed_at = now(),
               drop_player_id = NULL
         WHERE status = 'pending'
           AND league_id = OLD.league_id
           AND league_season_id = OLD.league_season_id
           AND member_id = OLD.member_id
           AND drop_player_id = OLD.player_id
         RETURNING id, member_id, failure_reason
      )
      SELECT private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT 'trade_claim_cancelled:'||id,member_id,'trade_claim_cancelled','Waiver claim cancelled',failure_reason,
        jsonb_build_object('claimId',id),'trade'
      FROM changed_claims) AS notification(dedupe_key,member_id,event_type,title,body,data,category))) INTO v_notifications_queued;
    ELSE
      UPDATE waiver_claims
         SET drop_player_id = NULL
       WHERE status = 'pending'
         AND league_id = OLD.league_id
         AND league_season_id = OLD.league_season_id
         AND member_id = OLD.member_id
         AND drop_player_id = OLD.player_id;
    END IF;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
END;
$$;



CREATE OR REPLACE FUNCTION private.notif_enqueue(p_event text, p_occurrence text, p_league_id uuid, p_member_id uuid, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT p_event || ':' || p_occurrence || ':' || member.id,member.id,p_event,event.label,
    COALESCE(p_data->>'body',event.label || '. Open Pancake for details.'),
    p_data || jsonb_build_object('leagueId',p_league_id,'notificationEvent',p_event),event.category
  FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NULL CROSS JOIN public.notif_event_catalog event
  WHERE member.id = p_member_id AND member.league_id = p_league_id AND event.event_type = p_event) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));
END;
$$;


CREATE OR REPLACE FUNCTION private.enqueue_trade_participant_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_trade public.trades%ROWTYPE;
  v_event_type text;
  v_title text;
  v_body text;
  v_all_accepted boolean;
BEGIN
  SELECT * INTO v_trade FROM public.trades WHERE id = NEW.trade_id;
  IF NOT FOUND OR v_trade.status <> 'pending'::public.trade_status THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_initiator THEN RETURN NEW; END IF;
    v_event_type := CASE
      WHEN v_trade.countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN v_trade.edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END;
    v_title := CASE
      WHEN v_event_type = 'trade_countered' THEN CASE WHEN v_trade.is_multi_team THEN 'Multi-Team Trade Countered' ELSE 'Trade Countered' END
      WHEN v_event_type = 'trade_edited' THEN CASE WHEN v_trade.is_multi_team THEN 'Multi-Team Trade Edited' ELSE 'Trade Edited' END
      ELSE CASE WHEN v_trade.is_multi_team THEN 'New Multi-Team Trade' ELSE 'New Trade Offer' END
    END;
    v_body := CASE
      WHEN v_event_type = 'trade_countered' THEN CASE WHEN v_trade.is_multi_team THEN 'A multi-team counteroffer is waiting for your review.' ELSE 'A trade offer was countered and is waiting for your review.' END
      WHEN v_event_type = 'trade_edited' THEN CASE WHEN v_trade.is_multi_team THEN 'A pending multi-team trade offer was updated.' ELSE 'A pending trade offer was updated.' END
      ELSE CASE WHEN v_trade.is_multi_team THEN 'A multi-team trade offer is waiting for your review.' ELSE 'You have a new trade offer waiting for your review.' END
    END;

    PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT
      format('%s:%s:%s', v_event_type, v_trade.id, NEW.member_id),
      NEW.member_id, v_event_type, v_title, v_body,
      jsonb_build_object('tradeId', v_trade.id, 'leagueId', v_trade.league_id), 'trade'
    WHERE EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = NEW.member_id AND member.league_id = v_trade.league_id)) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));
    RETURN NEW;
  END IF;

  IF OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
  SELECT NOT EXISTS (
    SELECT 1 FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.trade_id AND participant.accepted_at IS NULL
  ) INTO v_all_accepted;

  v_event_type := CASE WHEN v_all_accepted THEN 'trade_accepted' ELSE 'trade_participant_accepted' END;
  v_title := CASE
    WHEN v_all_accepted AND v_trade.is_multi_team THEN 'Multi-Team Trade Accepted'
    WHEN v_all_accepted THEN 'Trade Accepted'
    ELSE 'Trade Participant Accepted'
  END;
  v_body := CASE
    WHEN v_all_accepted AND v_trade.is_multi_team THEN 'Every participant accepted the multi-team trade. Completion will follow your league veto settings.'
    WHEN v_all_accepted THEN 'The trade was accepted. Completion will follow your league veto settings.'
    ELSE 'A participant accepted the multi-team trade offer.'
  END;

  PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT
    format('%s:%s:%s:%s', v_event_type, v_trade.id, NEW.member_id, recipient.member_id),
    recipient.member_id, v_event_type, v_title, v_body,
    jsonb_build_object('tradeId', v_trade.id, 'leagueId', v_trade.league_id), 'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.trade_id
       AND participant.member_id <> NEW.member_id
       AND v_all_accepted
    UNION SELECT v_trade.proposer_member_id WHERE NOT v_all_accepted AND v_trade.proposer_member_id <> NEW.member_id
  ) AS recipient
  WHERE EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = recipient.member_id AND member.league_id = v_trade.league_id)) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION private.enqueue_trade_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type text;
  v_title text;
  v_body text;
  v_single_recipient uuid;
  v_all_participants boolean := false;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
    v_all_participants := true;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'rejected'::public.trade_status THEN
    v_event_type := 'trade_rejected';
    v_title := 'Trade Rejected';
    v_body := 'Your trade offer was declined.';
    v_single_recipient := NEW.proposer_member_id;
    v_all_participants := COALESCE(NEW.is_multi_team, false);
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'withdrawn'::public.trade_status THEN
    v_event_type := 'trade_withdrawn';
    v_title := 'Trade Withdrawn';
    v_body := 'A trade offer sent to you has been withdrawn.';
    v_all_participants := COALESCE(NEW.is_multi_team, false);
    v_single_recipient := NEW.recipient_member_id;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
    v_all_participants := true;
  ELSIF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'vetoed'::public.trade_status THEN
    v_event_type := 'trade_vetoed';
    v_title := 'Trade Vetoed';
    v_body := 'An accepted trade was vetoed before completion.';
    v_all_participants := true;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT
    format('%s:%s:%s', v_event_type, NEW.id, recipient.member_id),
    recipient.member_id,
    v_event_type,
    v_title,
    v_body,
    jsonb_build_object('tradeId', NEW.id, 'leagueId', NEW.league_id),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.id
       AND v_all_participants
       AND (v_event_type <> 'trade_withdrawn' OR participant.member_id <> NEW.proposer_member_id)
       AND (v_event_type <> 'trade_rejected' OR participant.member_id = NEW.proposer_member_id OR participant.accepted_at IS NOT NULL)
    UNION SELECT v_single_recipient WHERE NOT v_all_participants
  ) AS recipient
  WHERE recipient.member_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = recipient.member_id AND member.league_id = NEW.league_id)) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notifications_queued integer;
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
  v_drop record;
  v_move record;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
      UNION SELECT (move->>'playerId')::uuid FROM trade_participants,jsonb_array_elements(roster_moves) move WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.validate_trade_rosters(p_trade_id);

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false))
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

    END IF;
  END LOOP;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  -- A reserved pick may only change hands through this completion; the
  -- draft_picks guard and the trade status guard honour this mark.
  v_previous_flag := private.begin_trade_lifecycle_write();
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  FOR v_move IN SELECT roster.id,roster.member_id,roster.player_id,roster.is_on_ir,roster.is_on_taxi,move->>'destination' AS destination
    FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    JOIN roster_players roster ON roster.player_id=(move->>'playerId')::uuid AND roster.member_id=participant.member_id
      AND roster.league_season_id=v_trade.league_season_id
    WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
  LOOP
    IF private.roster_status_game_started(v_move.player_id) THEN
      RAISE EXCEPTION 'A planned roster move waits for the player game slate to end.' USING ERRCODE='PT002';
    END IF;
    PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,'trade',p_trade_id);
    UPDATE roster_players SET is_on_ir=v_move.destination='ir',is_on_taxi=false WHERE id=v_move.id;
    INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
      VALUES(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,
        CASE WHEN v_move.destination='ir' THEN 'ir_designate' WHEN v_move.is_on_taxi THEN 'taxi_return' ELSE 'ir_return' END,p_trade_id);
  END LOOP;

  WITH changed_claims AS (
    UPDATE waiver_claims AS claim
       SET status = 'cancelled',
           failure_reason = 'The selected drop player left this roster in another transaction.',
           processed_at = now(),
           drop_player_id = NULL
     WHERE claim.status = 'pending'
       AND claim.league_id = v_trade.league_id
       AND claim.league_season_id = v_trade.league_season_id
       AND EXISTS (
         SELECT 1 FROM trade_items AS item
          WHERE item.trade_id = p_trade_id
            AND item.from_member_id = claim.member_id
            AND item.player_id = claim.drop_player_id
            AND (v_league.allow_inactive_trades OR item.to_taxi OR item.to_ir)
       )
     RETURNING claim.id, claim.member_id, claim.failure_reason
  )
  SELECT private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT 'trade_claim_cancelled:' || id, member_id, 'trade_claim_cancelled', 'Waiver claim cancelled',
    failure_reason, jsonb_build_object('claimId', id), 'trade'
  FROM changed_claims) AS notification(dedupe_key,member_id,event_type,title,body,data,category))) INTO v_notifications_queued;

  UPDATE waiver_claims AS claim
     SET drop_player_id = NULL
   WHERE claim.status = 'pending'
     AND claim.league_id = v_trade.league_id
     AND claim.league_season_id = v_trade.league_season_id
     AND EXISTS (
       SELECT 1 FROM trade_items AS item
        WHERE item.trade_id = p_trade_id
          AND item.from_member_id = claim.member_id
          AND item.player_id = claim.drop_player_id
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      IF v_item.to_taxi OR v_league.allow_inactive_trades THEN
        PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      END IF;
      BEGIN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade',
             is_on_taxi = v_item.to_taxi OR (v_league.allow_inactive_trades AND is_on_taxi),
             is_on_ir = CASE WHEN v_league.allow_inactive_trades THEN v_item.to_ir ELSE is_on_ir END
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false));

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        -- A game in progress only delays a taxi destination: keep the accepted trade for a later run.
        IF v_item.to_taxi AND SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PT002';
        END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION '% acquisition failed: %',
          CASE WHEN v_item.to_taxi THEN 'Taxi' WHEN v_item.to_ir THEN 'IR' ELSE 'Player' END,
          SQLERRM USING ERRCODE='PT001';
      END;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        acquired_to_taxi,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', false, p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', v_item.to_taxi, p_trade_id);
    ELSIF v_item.pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  FOR v_member_lock IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_member_lock);
  END LOOP;
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;




CREATE OR REPLACE FUNCTION public.finalize_score_week_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb,
  p_standings jsonb,
  p_finalized_at timestamptz DEFAULT now(),
  p_reconciliation_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_count int;
  v_distinct_count int;
  v_locked_count int;
  v_notifications jsonb := '[]'::jsonb;
  v_input_token jsonb;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_standings IS NULL OR jsonb_typeof(p_standings) <> 'array' THEN
    RAISE EXCEPTION 'p_standings must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT requested.id)
    INTO v_requested_count, v_distinct_count
    FROM jsonb_to_recordset(p_matchups) AS requested(
      id uuid,
      winner_member_id uuid,
      home_max_possible_points numeric,
      away_max_possible_points numeric
    );

  IF v_requested_count = 0 THEN
    RETURN v_notifications;
  END IF;

  IF v_distinct_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains duplicate matchup ids.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN '[]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  v_input_token := p_matchups->0->'input_token';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item->'input_token' IS DISTINCT FROM v_input_token)
      OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token) THEN
    RAISE EXCEPTION 'Score inputs changed or were not certified. Retry scoring.' USING ERRCODE = 'PT409';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  )
  SELECT count(*)
    INTO v_locked_count
    FROM locked;

  IF v_locked_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.'
      USING ERRCODE = '22023';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  ),
  updated AS (
    UPDATE public.matchups AS matchup
       SET winner_member_id = locked.requested_winner_member_id,
           home_points = COALESCE(locked.requested_home_points, locked.home_points),
           away_points = COALESCE(locked.requested_away_points, locked.away_points),
           home_max_possible_points = locked.requested_home_max_possible_points,
           away_max_possible_points = locked.requested_away_max_possible_points,
           is_finalized = true,
           score_read_started_at = COALESCE(locked.requested_score_read_started_at, p_finalized_at),
           finalized_at = CASE
             WHEN locked.is_finalized IS FALSE THEN p_finalized_at
             WHEN locked.matchup_type IN (
               'playoff_quarterfinal'::matchup_type,
               'playoff_semifinal'::matchup_type,
               'playoff_final'::matchup_type
             ) AND (locked.winner_member_id IS DISTINCT FROM locked.requested_winner_member_id
               OR locked.home_max_possible_points IS DISTINCT FROM locked.requested_home_max_possible_points
               OR locked.away_max_possible_points IS DISTINCT FROM locked.requested_away_max_possible_points) THEN p_reconciliation_at
             ELSE matchup.finalized_at
           END
      FROM locked
     WHERE matchup.id = locked.id
       AND NOT private.playoff_matchup_is_consumed(locked.id)
       AND (locked.is_finalized IS DISTINCT FROM true
         OR (locked.winner_member_id, locked.home_points, locked.away_points,
             locked.home_max_possible_points, locked.away_max_possible_points)
           IS DISTINCT FROM
            (locked.requested_winner_member_id,
             COALESCE(locked.requested_home_points, locked.home_points),
             COALESCE(locked.requested_away_points, locked.away_points),
             locked.requested_home_max_possible_points, locked.requested_away_max_possible_points))
     RETURNING
       matchup.id,
       locked.is_finalized AS was_finalized,
       matchup.home_member_id,
       matchup.away_member_id,
       matchup.home_points,
       matchup.away_points,
       matchup.winner_member_id
  ),
  notification_rows AS (
    SELECT *
      FROM updated
     WHERE was_finalized IS FALSE
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'home_member_id', home_member_id,
        'away_member_id', away_member_id,
        'home_points', home_points,
        'away_points', away_points,
        'winner_member_id', winner_member_id
      )
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_notifications
    FROM notification_rows;


  PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT 'matchup:'||result.id||':final:'||recipient.member_id,
    recipient.member_id,'matchup_final',
    CASE WHEN COALESCE(matchup.end_week_number,p_week_number)=p_week_number
      THEN 'Week '||p_week_number ELSE 'Weeks '||p_week_number||'–'||matchup.end_week_number END||' Final',
    CASE WHEN result.winner_member_id IS NULL THEN 'You tied '
      WHEN result.winner_member_id=recipient.member_id THEN 'You won '
      ELSE 'You lost ' END
      ||round(COALESCE(recipient.points,0),2)::text||'–'||round(COALESCE(recipient.opponent_points,0),2)::text
      ||CASE WHEN result.winner_member_id=recipient.member_id THEN '! 🏆' ELSE '.' END,
    jsonb_build_object('type','matchup_final','leagueId',p_league_id,'leagueSeasonId',p_league_season_id,
      'matchupId',result.id,'weekNumber',p_week_number,'endWeekNumber',COALESCE(matchup.end_week_number,p_week_number)),
    'activity'
  FROM jsonb_to_recordset(v_notifications) result(id uuid,home_member_id uuid,away_member_id uuid,
    home_points numeric,away_points numeric,winner_member_id uuid)
  JOIN public.matchups matchup ON matchup.id=result.id
  CROSS JOIN LATERAL (VALUES(result.home_member_id,result.home_points,result.away_points),
    (result.away_member_id,result.away_points,result.home_points)) recipient(member_id,points,opponent_points)) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));

  INSERT INTO public.standings (
    league_id,
    league_season_id,
    member_id,
    week_number,
    created_at,
    wins,
    losses,
    ties,
    points_for,
    points_against,
    max_possible_points
  )
  SELECT
    p_league_id,
    p_league_season_id,
    standing.member_id,
    p_week_number,
    COALESCE(standing.created_at, p_finalized_at),
    standing.wins,
    standing.losses,
    standing.ties,
    standing.points_for,
    standing.points_against,
    standing.max_possible_points
  FROM jsonb_to_recordset(p_standings) AS standing(
    member_id uuid,
    created_at timestamptz,
    wins int,
    losses int,
    ties int,
    points_for numeric,
    points_against numeric,
    max_possible_points numeric
  )
  ON CONFLICT (league_id, league_season_id, member_id, week_number)
  DO UPDATE SET
    created_at = EXCLUDED.created_at,
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points
  WHERE (standings.wins, standings.losses, standings.ties,
         standings.points_for, standings.points_against, standings.max_possible_points)
    IS DISTINCT FROM
        (EXCLUDED.wins, EXCLUDED.losses, EXCLUDED.ties,
         EXCLUDED.points_for, EXCLUDED.points_against, EXCLUDED.max_possible_points);

  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND cardinality(skipped_weeks)>0) THEN
    PERFORM private.rebuild_regular_standings(p_league_id,p_league_season_id);
  END IF;

  INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
    VALUES(p_league_season_id, p_week_number, private.score_input_token(p_league_season_id, p_week_number))
    ON CONFLICT(league_season_id, week_number) DO UPDATE SET input_token = EXCLUDED.input_token
    WHERE score_week_certificates.input_token IS DISTINCT FROM EXCLUDED.input_token;

  RETURN '[]'::jsonb;
END;
$$;


CREATE OR REPLACE FUNCTION public.expire_trade_completion_failure_atomic(
  p_trade_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_rows int;
  v_league_status text;
  v_is_current boolean;
  v_reason text := COALESCE(NULLIF(BTRIM(p_reason), ''), 'The accepted trade could not be completed.');
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'accepted'
     AND veto_window_expires_at <= now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade is not an expired accepted trade';
  END IF;

  SELECT status
    INTO v_league_status
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT is_current
    INTO v_is_current
    FROM league_seasons
   WHERE id = v_trade.league_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade season not found.';
  END IF;

  IF v_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Trades require the current season.';
  END IF;

  IF v_league_status = 'archived' THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = v_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;

  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_trade_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    v_trade.league_id,
    v_trade.league_season_id,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    v_trade.id,
    'trade_completion_failed',
    'Accepted trade expired',
    v_reason,
    jsonb_build_object('reason', v_reason, 'terminal', true)
  );

  PERFORM private.enqueue_notifications((SELECT coalesce(jsonb_agg(to_jsonb(notification)),'[]'::jsonb) FROM (SELECT
    format('trade_terminal_failure:%s:%s', v_trade.id, recipient.member_id),
    recipient.member_id,
    'trade_completion_failed',
    'Accepted Trade Expired',
    'An accepted trade could not be completed. Check the trade activity for details.',
    jsonb_build_object('tradeId', v_trade.id, 'reason', v_reason),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = v_trade.id
    UNION
    SELECT v_trade.proposer_member_id
    UNION
    SELECT v_trade.recipient_member_id
  ) AS recipient) AS notification(dedupe_key,member_id,event_type,title,body,data,category)));
END;
$$;

CREATE OR REPLACE FUNCTION private.drop_expired_notification_partitions(p_now timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE part record; eligible boolean; removed bigint:=0; counted bigint; month_offset integer;
BEGIN
  FOR month_offset IN 0..2 LOOP
    PERFORM private.ensure_log_partition('public.notification_outbox',((p_now AT TIME ZONE 'UTC')::date+make_interval(months=>month_offset))::date);
  END LOOP;
  FOR part IN SELECT partition_table FROM private.log_partitions
    WHERE parent_table='public.notification_outbox'::regclass AND upper_bound::timestamp AT TIME ZONE 'UTC'<=p_now-interval '60 days'
    ORDER BY lower_bound LIMIT 12 LOOP
    EXECUTE format('SELECT NOT EXISTS(SELECT FROM %s WHERE coalesce(delivered_at,dead_lettered_at,suppressed_at) IS NULL OR coalesce(delivered_at,dead_lettered_at,suppressed_at)>=$1-interval ''60 days'')',part.partition_table) INTO eligible USING p_now;
    IF NOT eligible THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %s',part.partition_table) INTO counted;
    DELETE FROM private.retention_status WHERE relation_name=part.partition_table::text;
    DELETE FROM private.retention_rules WHERE relation_name=part.partition_table::text;
    EXECUTE format('DROP TABLE %s',part.partition_table);
    DELETE FROM private.log_partitions WHERE partition_table=part.partition_table;
    removed:=removed+counted;
  END LOOP;
  RETURN removed;
END;
$$;
CREATE OR REPLACE FUNCTION private.retain_notification_outbox(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; dropped bigint;
BEGIN
  dropped:=private.drop_expired_notification_partitions(p_now);
  WITH victims AS (
    SELECT r.id FROM public.notification_outbox r
    WHERE COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at)<p_now-interval '60 days'
    ORDER BY COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at),r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.notification_outbox r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.notification_outbox',v_count+dropped);
END;
$$;
DO $$ DECLARE child regclass; BEGIN
  FOR child IN SELECT inhrelid FROM pg_inherits WHERE inhparent='public.notification_outbox'::regclass LOOP
    EXECUTE format('GRANT SELECT ON %s TO service_role',child);
  END LOOP;
END; $$;
ALTER FUNCTION private.enqueue_notifications(jsonb) OWNER TO postgres;
ALTER FUNCTION private.drop_expired_notification_partitions(timestamptz) OWNER TO postgres;
ALTER FUNCTION public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.enqueue_notifications(jsonb),private.drop_expired_notification_partitions(timestamptz),public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_rookie_pick_notification(uuid,uuid,uuid,uuid) TO service_role;
UPDATE private.retention_rules SET retention_rule='Terminal notifications sixty days; drop complete eligible months; retain pending notifications; delete at most 5000 boundary rows' WHERE relation_name='public.notification_outbox';
NOTIFY pgrst,'reload schema';
