CREATE OR REPLACE FUNCTION private.timeline_event_catalog()
RETURNS TABLE(kind text, category text, visibility text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('claim.awarded', 'claims', 'public'),
    ('claim.failed', 'claims', 'member'),
    ('trade.sent', 'trades', 'participants'),
    ('trade.countered', 'trades', 'participants'),
    ('trade.edited', 'trades', 'participants'),
    ('trade.accepted', 'trades', 'participants'),
    ('trade.vetoed', 'trades', 'public'),
    ('trade.executed', 'trades', 'public'),
    ('trade.failed', 'trades', 'participants'),
    ('trade.rejected', 'trades', 'participants'),
    ('trade.withdrawn', 'trades', 'participants'),
    ('trade.expired', 'trades', 'participants'),
    ('lineup.auto_set', 'lineups', 'public'),
    ('scores.finalized', 'scores', 'public'),
    ('pick.made', 'picks', 'public'),
    ('draft.pick', 'picks', 'public'),
    ('settings.changed', 'settings', 'public'),
    ('league.settings_changed', 'settings', 'public');
$$;


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


CREATE OR REPLACE FUNCTION private.log_league_activity(
  p_league_id uuid,
  p_league_season_id uuid,
  p_event_type text,
  p_title text,
  p_body text DEFAULT NULL,
  p_actor_member_id uuid DEFAULT NULL,
  p_target_member_id uuid DEFAULT NULL,
  p_related_player_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_related_claim_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    related_claim_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_actor_member_id,
    p_target_member_id,
    p_related_player_id,
    p_related_trade_id,
    p_related_claim_id,
    p_event_type,
    p_title,
    p_body,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  IF p_related_trade_id IS NOT NULL AND p_event_type IN ('trade_offered','trade_countered','trade_edited') THEN
    INSERT INTO public.league_events(league_id,kind,summary,detail)
    SELECT trade.league_id,
      CASE p_event_type WHEN 'trade_countered' THEN 'trade.countered' WHEN 'trade_edited' THEN 'trade.edited' ELSE 'trade.sent' END,
      p_title,
      to_jsonb(trade) || jsonb_build_object('reason', p_body, 'member_ids',
        (SELECT jsonb_agg(member_id ORDER BY sort_order, member_id) FROM public.trade_participants WHERE trade_id=trade.id))
    FROM public.trades trade WHERE trade.id=p_related_trade_id
      AND (p_event_type<>'trade_offered' OR (trade.countered_from_trade_id IS NULL AND trade.edited_from_trade_id IS NULL));
  END IF;

  RETURN v_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.view_team_timeline(
  p_league_id uuid,
  p_member_id uuid,
  p_before jsonb DEFAULT NULL,
  p_limit integer DEFAULT 30
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  viewer uuid;
  before_time timestamptz;
  before_id bigint;
  entries jsonb;
  more boolean;
  page_limit integer := coalesce(p_limit, 30);
BEGIN
  SELECT id INTO viewer FROM public.league_members
    WHERE league_id = p_league_id AND user_id = auth.uid();
  IF viewer IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.league_members WHERE id = p_member_id AND league_id = p_league_id
  ) THEN
    RAISE EXCEPTION 'This team timeline is not available.' USING ERRCODE = '42501';
  END IF;
  IF page_limit < 1 OR page_limit > 100 THEN
    RAISE EXCEPTION 'Timeline limit must be between 1 and 100.' USING ERRCODE = '22023';
  END IF;
  IF p_before IS NOT NULL AND p_before <> 'null'::jsonb THEN
    BEGIN
      before_time := (p_before->>'createdAt')::timestamptz;
      before_id := (p_before->>'id')::bigint;
      IF jsonb_typeof(p_before) <> 'object' OR before_time IS NULL OR before_id IS NULL
        OR before_id < 1 OR NOT isfinite(before_time) THEN
        RAISE EXCEPTION 'Invalid cursor';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Timeline cursor is invalid.' USING ERRCODE = '22023';
    END;
  END IF;
  WITH related AS (
    SELECT event.*, catalog.visibility,
      ARRAY_REMOVE(ARRAY[
        event.member_id::text, event.detail->>'member_id', event.detail->>'proposer_member_id',
        event.detail->>'recipient_member_id', event.detail->>'home_member_id', event.detail->>'away_member_id'
      ], NULL) || ARRAY(
        SELECT participant.member_id::text FROM public.trade_participants participant
        WHERE participant.trade_id::text = coalesce(event.detail->>'trade_id', event.detail->>'id')
          AND event.kind LIKE 'trade.%'
      ) || ARRAY(
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(event.detail->'member_ids') = 'array'
          THEN event.detail->'member_ids' ELSE '[]'::jsonb END)
      ) AS members
    FROM public.league_events event
    JOIN private.timeline_event_catalog() catalog ON catalog.kind=event.kind
    WHERE event.league_id = p_league_id
      AND (before_time IS NULL OR (event.created_at, event.id) < (before_time, before_id))
  ), visible AS (
    SELECT * FROM related
    WHERE (p_member_id::text = ANY(members)
      OR (cardinality(members) = 0 AND kind IN ('settings.changed', 'league.settings_changed')))
      AND (visibility <> 'member' OR member_id = viewer)
      AND (visibility <> 'participants' OR viewer::text = ANY(members))
    ORDER BY created_at DESC, id DESC LIMIT page_limit + 1
  ), page AS (
    SELECT * FROM visible ORDER BY created_at DESC, id DESC LIMIT page_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id::text, 'createdAt', page.created_at, 'kind', page.kind, 'summary', page.summary,
    'memberId', page.member_id,
    'reason', coalesce(page.detail->>'failure_reason', page.detail->>'completion_failure_reason', page.detail->>'reason', page.detail->>'error'),
    'entityId', coalesce(page.detail->>'trade_id', page.detail->>'claim_id', page.detail->>'matchup_id', page.detail->>'id'),
    'threadId', CASE WHEN page.kind LIKE 'trade.%' THEN coalesce(page.detail->>'parent_trade_id',
      page.detail->>'countered_from_trade_id', page.detail->>'trade_id', page.detail->>'id') END,
    'detail', CASE WHEN page.member_id = viewer THEN page.detail ELSE (
      SELECT coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
      FROM jsonb_each(page.detail) field WHERE field.key IN (
        'id', 'trade_id', 'claim_id', 'matchup_id', 'player_id', 'member_id', 'proposer_member_id',
        'recipient_member_id', 'home_member_id', 'away_member_id', 'status', 'game_date', 'week_number',
        'home_points', 'away_points', 'failure_reason', 'reason', 'pick_number', 'round', 'changes'
      )
    ) END
  ) ORDER BY page.created_at DESC, page.id DESC), '[]'::jsonb),
    (SELECT count(*) > page_limit FROM visible)
  INTO entries, more FROM page;
  RETURN jsonb_build_object('events', entries, 'hasMore', more, 'nextCursor',
    CASE WHEN more THEN jsonb_build_object('createdAt', entries->-1->'createdAt', 'id', entries->-1->'id') END);
END;
$$;


CREATE TRIGGER league_events_trade_acceptance AFTER UPDATE OF accepted_at ON public.trade_participants
  FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE TRIGGER league_events_pick AFTER INSERT OR UPDATE OF player_id ON public.snake_draft_picks
  FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE TRIGGER league_events_auction AFTER UPDATE OF status ON public.nominations
  FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();
CREATE TRIGGER league_events_settings AFTER UPDATE ON public.leagues
  FOR EACH ROW EXECUTE FUNCTION private.work_capture_outcome();

REVOKE ALL ON FUNCTION private.timeline_event_catalog() FROM PUBLIC, anon, authenticated, service_role;
REVOKE SELECT ON public.league_events FROM authenticated;
GRANT SELECT(id,league_id,member_id,kind,summary,created_at) ON public.league_events TO authenticated;
DROP POLICY league_events_member_read ON public.league_events;
CREATE POLICY league_events_member_read ON public.league_events FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.league_members member
  WHERE member.league_id=league_events.league_id AND member.user_id=auth.uid()
    AND (league_events.kind<>'claim.failed' OR member.id=league_events.member_id)
    AND (league_events.kind NOT IN ('trade.sent','trade.countered','trade.edited','trade.accepted','trade.failed','trade.rejected','trade.withdrawn','trade.expired')
      OR league_events.detail->'member_ids' ? member.id::text
      OR member.id::text IN (league_events.detail->>'proposer_member_id',league_events.detail->>'recipient_member_id'))));
