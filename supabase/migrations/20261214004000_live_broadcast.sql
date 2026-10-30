BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

CREATE OR REPLACE FUNCTION private.can_receive_live_broadcast(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE parts text[]:=string_to_array(p_topic,':'); target uuid;
BEGIN
  IF cardinality(parts)<>3 OR parts[1]<>'l1' OR auth.uid() IS NULL
    OR parts[3]!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  target:=parts[3]::uuid;
  CASE parts[2]
    WHEN 'user' THEN RETURN target=auth.uid();
    WHEN 'member' THEN RETURN EXISTS(SELECT 1 FROM public.league_members WHERE id=target AND user_id=auth.uid());
    WHEN 'league' THEN RETURN EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
      WHERE league.id=target AND league.deleted_at IS NULL AND member.user_id=auth.uid());
    WHEN 'draft' THEN RETURN EXISTS(SELECT 1 FROM public.drafts draft JOIN public.league_members member ON member.league_id=draft.league_id
      JOIN public.leagues league ON league.id=draft.league_id
      WHERE draft.id=target AND league.deleted_at IS NULL AND member.user_id=auth.uid());
    ELSE RETURN false;
  END CASE;
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
    PERFORM realtime.send(payload,'change',target,true);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.can_receive_live_broadcast(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.can_receive_live_broadcast(text) TO authenticated;
REVOKE ALL ON FUNCTION private.broadcast_live_change() FROM PUBLIC,anon,authenticated;

DROP POLICY authenticated_can_receive_realtime ON realtime.messages;
CREATE POLICY authenticated_can_receive_realtime ON realtime.messages FOR SELECT TO authenticated
  USING(CASE WHEN topic LIKE 'l1:%'
    THEN topic=(SELECT realtime.topic()) AND private.can_receive_live_broadcast((SELECT realtime.topic())) ELSE true END);

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.draft_budgets
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.draft_picks
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.drafts
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.league_change_hints
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.league_members
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.leagues
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.matchup_forecasts
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.nominations
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.roster_players
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.snake_draft_picks
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.trade_block_items
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.trade_items
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.trade_participants
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.trade_vetos
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.trades
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public.waiver_claims
  FOR EACH ROW EXECUTE FUNCTION private.broadcast_live_change();

COMMIT;
