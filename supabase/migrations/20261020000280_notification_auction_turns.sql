-- Auction drafts had no turn notifications: notif_draft_clock only read snake
-- picks, so an auction nominator never got draft_on_clock ("Your turn") and the
-- next nominator never got draft_coming_soon. Auction turns are keyed by
-- drafts.current_nomination_order; a turn row goes stale once the order moves
-- on or the nominator opens a nomination. Auctions keep no per-member timer and
-- no auto-pick, so auction draft_timer_expiring is always stale.
--
-- A reset keeps the draft id and restarts the order at 1, so turn keys carry
-- the reset generation (count of 'reset' audit rows) and older-generation rows
-- are stale.
--
-- draft_orders are inserted after the drafts row, a closing nomination can
-- advance the order and complete the draft in separate statements, and a reset
-- writes its audit row after restarting the draft, so the triggers are deferred
-- to commit and read the settled draft.

CREATE OR REPLACE FUNCTION private.notif_draft_clock(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  n public.snake_draft_picks%ROWTYPE;
  seats int;
  nominator uuid;
  next_nominator uuid;
  resets int;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = p_draft_id;
  IF d.status <> 'in_progress' OR d.is_mock THEN RETURN; END IF;
  IF d.draft_type = 'auction' THEN
    SELECT count(*) INTO seats FROM public.draft_orders WHERE draft_id = d.id;
    IF seats = 0 OR EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = d.id AND status = 'open') THEN RETURN; END IF;
    SELECT member_id INTO nominator FROM public.draft_orders
      WHERE draft_id = d.id AND position = ((d.current_nomination_order - 1) % seats) + 1;
    SELECT member_id INTO next_nominator FROM public.draft_orders
      WHERE draft_id = d.id AND position = (d.current_nomination_order % seats) + 1;
    -- A reset restarts the order on the same draft, so turns are keyed per reset.
    SELECT count(*) INTO resets FROM public.draft_audit_logs WHERE draft_id = d.id AND action = 'reset';
    PERFORM private.notif_enqueue('draft_on_clock',d.id::text || ':nomination:' || resets || ':' || d.current_nomination_order,d.league_id,nominator,
      jsonb_build_object('draftId',d.id,'resets',resets,'nominationOrder',d.current_nomination_order,'body','You are on the clock to nominate a player.'));
    IF next_nominator IS DISTINCT FROM nominator THEN
      PERFORM private.notif_enqueue('draft_coming_soon',d.id::text || ':nomination:' || resets || ':' || (d.current_nomination_order + 1),d.league_id,next_nominator,
        jsonb_build_object('draftId',d.id,'resets',resets,'nominationOrder',d.current_nomination_order + 1));
    END IF;
    RETURN;
  END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL
    ORDER BY overall_pick LIMIT 1;
  IF p.id IS NULL OR p.timer_expires_at IS NULL THEN RETURN; END IF;
  PERFORM private.notif_enqueue('draft_on_clock',p.id::text,d.league_id,p.member_id,
    jsonb_build_object('draftId',d.id,'pickId',p.id,'body',format('You are on the clock for pick %s.',p.overall_pick)));
  SELECT * INTO n FROM public.snake_draft_picks WHERE draft_id = d.id AND overall_pick > p.overall_pick
    AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  IF n.id IS NOT NULL THEN
    PERFORM private.notif_enqueue('draft_coming_soon',n.id::text,d.league_id,n.member_id,
      jsonb_build_object('draftId',d.id,'pickId',n.id));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_is_stale(p_event text, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_event IN ('lineup_inactive','lineup_empty') THEN
    RETURN NOT EXISTS(SELECT 1 FROM private.notif_lineup_candidates(clock_timestamp()) c
      WHERE c.event_type=p_event AND c.league_id::text=p_data->>'leagueId'
        AND c.member_id::text=p_data->>'memberId' AND c.game_date::text=p_data->>'gameDate'
        AND (p_event='lineup_empty' OR c.player_id::text=p_data->>'playerId'));
  END IF;
  IF p_event='matchup_close' THEN
    RETURN NOT EXISTS(SELECT 1 FROM public.matchups m
      JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
      JOIN public.season_weeks ending ON ending.season_year=s.season_year AND ending.week_number=COALESCE(m.end_week_number,m.week_number)
      WHERE m.id::text=p_data->>'matchupId' AND NOT m.is_finalized AND NOT m.is_voided AND m.winner_member_id IS NULL
        AND NOT m.week_number=ANY(s.skipped_weeks)
        AND (clock_timestamp() AT TIME ZONE 'America/New_York')::date=ending.week_end
        AND m.home_points IS NOT NULL AND m.away_points IS NOT NULL
        AND abs(m.home_points-m.away_points)<=greatest(10,(m.home_points+m.away_points)*0.025));
  END IF;
  IF p_event NOT IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') THEN RETURN false; END IF;
  IF p_data ? 'draftId' AND p_data ? 'nominationOrder' THEN
    SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
    IF d.id IS NULL OR d.is_mock OR d.draft_type <> 'auction' OR d.status NOT IN ('in_progress','paused')
      OR p_event = 'draft_timer_expiring'
      OR (SELECT count(*) FROM public.draft_audit_logs WHERE draft_id = d.id AND action = 'reset')::text IS DISTINCT FROM p_data->>'resets'
      THEN RETURN true; END IF;
    IF p_event = 'draft_coming_soon' THEN
      RETURN (d.current_nomination_order + 1)::text IS DISTINCT FROM p_data->>'nominationOrder';
    END IF;
    RETURN d.current_nomination_order::text IS DISTINCT FROM p_data->>'nominationOrder'
      OR EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = d.id AND status = 'open');
  END IF;
  IF NOT (p_data ? 'draftId' AND p_data ? 'pickId') THEN RETURN true; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
  IF d.id IS NULL OR d.is_mock OR d.status NOT IN ('in_progress','paused') THEN RETURN true; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE id::text = p_data->>'pickId' AND draft_id = d.id;
  IF p.id IS NULL OR p.picked_at IS NOT NULL OR p.skipped_at IS NOT NULL THEN RETURN true; END IF;
  IF d.status = 'paused' THEN RETURN false; END IF;
  SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
    WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  RETURN deadline IS NULL OR deadline <= clock_timestamp();
END;
$$;

CREATE CONSTRAINT TRIGGER notif_draft_order_trigger AFTER INSERT ON public.draft_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.notif_pick_trigger();
CREATE CONSTRAINT TRIGGER notif_auction_turn_trigger AFTER UPDATE OF current_nomination_order ON public.drafts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.draft_type = 'auction' AND OLD.status IS NOT DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.notif_draft_trigger();
CREATE CONSTRAINT TRIGGER notif_draft_reset_trigger AFTER INSERT ON public.draft_audit_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.action = 'reset')
  EXECUTE FUNCTION private.notif_pick_trigger();
