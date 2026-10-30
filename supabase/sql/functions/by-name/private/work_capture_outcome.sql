-- Canonical SQL source for private.work_capture_outcome.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.work_capture_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text;
  v_member uuid;
  v_summary text;
  v_league uuid;
  v_detail jsonb := to_jsonb(NEW);
  v_trade public.trades%ROWTYPE;
  v_draft public.drafts%ROWTYPE;
  v_changes jsonb;
BEGIN
  IF TG_TABLE_NAME='waiver_claims' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status::text NOT IN ('succeeded','failed_priority','failed_roster') THEN RETURN NEW; END IF;
    v_kind := CASE WHEN NEW.status::text='succeeded' THEN 'claim.awarded' ELSE 'claim.failed' END;
    v_member := NEW.member_id;
    v_league := NEW.league_id;
    v_summary := CASE WHEN NEW.status::text='succeeded' THEN 'Waiver claim awarded' ELSE 'Waiver claim failed' END;
  ELSIF TG_TABLE_NAME='trades' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    v_kind := CASE NEW.status::text WHEN 'completed' THEN 'trade.executed' WHEN 'vetoed' THEN 'trade.vetoed'
      WHEN 'rejected' THEN 'trade.rejected' WHEN 'withdrawn' THEN 'trade.withdrawn' WHEN 'expired' THEN 'trade.expired' END;
    IF v_kind IS NULL THEN RETURN NEW; END IF;
    v_summary := CASE NEW.status::text WHEN 'completed' THEN 'Trade executed' WHEN 'vetoed' THEN 'Trade vetoed'
      WHEN 'rejected' THEN 'Trade rejected' WHEN 'withdrawn' THEN 'Trade withdrawn' WHEN 'expired' THEN 'Trade expired' END;
    v_league := NEW.league_id;
    v_detail := v_detail || jsonb_build_object('member_ids', (SELECT jsonb_agg(member_id ORDER BY sort_order, member_id)
      FROM public.trade_participants WHERE trade_id=NEW.id));
  ELSIF TG_TABLE_NAME='trade_participants' THEN
    IF NEW.accepted_at IS NULL OR NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at THEN RETURN NEW; END IF;
    SELECT * INTO v_trade FROM public.trades WHERE id=NEW.trade_id;
    v_kind := 'trade.accepted';
    v_summary := 'Trade accepted';
    v_league := v_trade.league_id;
    v_detail := to_jsonb(v_trade) || jsonb_build_object('accepting_member_id', NEW.member_id,
      'member_ids', (SELECT jsonb_agg(member_id ORDER BY sort_order, member_id) FROM public.trade_participants WHERE trade_id=NEW.trade_id));
  ELSIF TG_TABLE_NAME='matchups' THEN
    IF NOT NEW.is_finalized OR OLD.is_finalized THEN RETURN NEW; END IF;
    v_kind := 'scores.finalized';
    v_summary := 'Matchup scores finalized';
    v_league := NEW.league_id;
  ELSIF TG_TABLE_NAME='snake_draft_picks' THEN
    IF NEW.player_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND NEW.player_id IS NOT DISTINCT FROM OLD.player_id THEN RETURN NEW; END IF;
    SELECT * INTO v_draft FROM public.drafts WHERE id=NEW.draft_id;
    IF v_draft.is_mock THEN RETURN NEW; END IF;
    v_kind := 'pick.made';
    v_summary := 'Draft pick made';
    v_member := NEW.member_id;
    v_league := v_draft.league_id;
    v_detail := v_detail || jsonb_build_object('pick_number', NEW.overall_pick);
  ELSIF TG_TABLE_NAME='nominations' THEN
    IF NEW.status::text<>'sold' OR NEW.winning_member_id IS NULL OR OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    SELECT * INTO v_draft FROM public.drafts WHERE id=NEW.draft_id;
    IF v_draft.is_mock THEN RETURN NEW; END IF;
    v_kind := 'pick.made';
    v_summary := 'Auction player awarded';
    v_member := NEW.winning_member_id;
    v_league := v_draft.league_id;
  ELSIF TG_TABLE_NAME='leagues' THEN
    SELECT jsonb_object_agg(field.key, jsonb_build_object('before', to_jsonb(OLD)->field.key, 'after', field.value))
      INTO v_changes FROM jsonb_each(v_detail) field
      WHERE field.key NOT IN ('id','created_at','updated_at','status','deleted_at','deleted_by','invite_code','slug','commissioner_id','taxi_rule')
        AND field.value IS DISTINCT FROM to_jsonb(OLD)->field.key;
    IF v_changes IS NULL THEN RETURN NEW; END IF;
    v_kind := 'settings.changed';
    v_summary := 'League settings changed';
    v_league := NEW.id;
    v_detail := jsonb_build_object('changes', v_changes);
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
    VALUES(v_league,v_member,v_kind,v_summary,v_detail);
  RETURN NEW;
END;
$$;
