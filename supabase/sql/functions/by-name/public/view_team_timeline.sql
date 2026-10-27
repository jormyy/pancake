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
