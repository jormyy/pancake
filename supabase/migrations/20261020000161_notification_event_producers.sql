SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.notif_enqueue(p_event text, p_occurrence text, p_league_id uuid, p_member_id uuid, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT p_event || ':' || p_occurrence || ':' || member.id,member.id,p_event,event.label,
    COALESCE(p_data->>'body',event.label || '. Open Pancake for details.'),
    p_data || jsonb_build_object('leagueId',p_league_id,'notificationEvent',p_event),event.category
  FROM public.league_members member CROSS JOIN public.notif_event_catalog event
  WHERE member.id = p_member_id AND member.league_id = p_league_id AND event.event_type = p_event
  ON CONFLICT (dedupe_key) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION private.notif_draft_clock(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  n public.snake_draft_picks%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = p_draft_id;
  IF d.status <> 'in_progress' OR d.is_mock THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION private.notif_draft_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event text;
  v_occurrence text;
  m record;
BEGIN
  IF NEW.is_mock THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    v_event := CASE WHEN NEW.status = 'in_progress' AND TG_OP = 'UPDATE' AND OLD.status = 'paused' THEN 'draft_resumed'
      WHEN NEW.status = 'in_progress' THEN 'draft_started'
      WHEN NEW.status = 'paused' THEN 'draft_paused' WHEN NEW.status = 'completed' THEN 'draft_finished' END;
    v_occurrence := CASE WHEN v_event IN ('draft_paused','draft_resumed') THEN NEW.id::text || ':' || gen_random_uuid()::text ELSE NEW.id::text END;
    IF v_event IS NOT NULL THEN
      FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
        PERFORM private.notif_enqueue(v_event,v_occurrence,NEW.league_id,m.id,jsonb_build_object('draftId',NEW.id));
      END LOOP;
    END IF;
  END IF;
  PERFORM private.notif_draft_clock(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_pick_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.notif_draft_clock(NEW.draft_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_draft_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = NEW.draft_id;
  IF NOT d.is_mock AND NEW.action = 'auto_pick' THEN
    PERFORM private.notif_enqueue('draft_auto_picked',NEW.id::text,d.league_id,(NEW.metadata->>'memberId')::uuid,
      jsonb_build_object('draftId',d.id,'playerId',NEW.metadata->>'playerId'));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_waiver_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  v_event := CASE WHEN NEW.status = 'succeeded' THEN 'waiver_claim_won'
    WHEN NEW.status IN ('failed_priority','failed_roster') THEN 'waiver_claim_lost' END;
  IF v_event IS NOT NULL THEN
    PERFORM private.notif_enqueue(v_event,NEW.id::text,NEW.league_id,NEW.member_id,
      jsonb_build_object('claimId',NEW.id,'playerId',NEW.player_id,'body',COALESCE(NEW.failure_reason,'Your waiver claim succeeded.')));
    PERFORM private.notif_enqueue('waivers_processed',NEW.league_season_id::text || ':' || NEW.process_date::text,
      NEW.league_id,NEW.member_id,jsonb_build_object('leagueSeasonId',NEW.league_season_id));
  END IF;
  IF NEW.status = 'failed_priority' AND NEW.failure_reason ILIKE '%higher FAAB bid%' THEN
    PERFORM private.notif_enqueue('faab_outbid',NEW.id::text,NEW.league_id,NEW.member_id,
      jsonb_build_object('claimId',NEW.id,'playerId',NEW.player_id));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_player_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_occurrence text := NEW.id::text || ':' || gen_random_uuid()::text;
BEGIN
  IF OLD.injury_status IS NOT DISTINCT FROM NEW.injury_status THEN RETURN NEW; END IF;
  FOR r IN SELECT DISTINCT roster.league_id,roster.member_id FROM public.roster_players roster
    JOIN public.league_seasons season ON season.id = roster.league_season_id AND season.is_current
    WHERE roster.player_id = NEW.id LOOP
    PERFORM private.notif_enqueue('owned_player_status',v_occurrence,r.league_id,r.member_id,
      jsonb_build_object('playerId',NEW.id,'body',NEW.display_name || ': ' || COALESCE(NEW.injury_status,'Available')));
    IF NEW.injury_status IS NOT NULL AND lower(NEW.injury_status) NOT IN ('healthy','active','available') THEN
      PERFORM private.notif_enqueue('owned_player_injured',v_occurrence,r.league_id,r.member_id,jsonb_build_object('playerId',NEW.id));
    END IF;
    IF lower(NEW.injury_status) IN ('out','o','ruled out') THEN
      PERFORM private.notif_enqueue('owned_player_ruled_out',v_occurrence,r.league_id,r.member_id,jsonb_build_object('playerId',NEW.id));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_weekly_limit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_limit int;
BEGIN
  SELECT weekly_add_limit INTO v_limit FROM public.leagues WHERE id = NEW.league_id;
  IF v_limit IS NOT NULL AND v_limit > 0 AND NEW.add_count >= v_limit
    AND (TG_OP = 'INSERT' OR OLD.add_count < v_limit) THEN
    PERFORM private.notif_enqueue('waiver_limit_reached',NEW.league_season_id::text || ':' || NEW.week_number::text,
      NEW.league_id,NEW.member_id,jsonb_build_object('leagueSeasonId',NEW.league_season_id,'week',NEW.week_number));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_season_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_current AND EXISTS (
    SELECT 1 FROM public.league_seasons WHERE league_id = NEW.league_id AND season_year < NEW.season_year
  ) THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
      PERFORM private.notif_enqueue('season_rollover',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  IF NEW.playoff_seed_member_ids IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.playoff_seed_member_ids IS DISTINCT FROM NEW.playoff_seed_member_ids) THEN
    FOR m IN SELECT unnest(NEW.playoff_seed_member_ids) AS id LOOP
      PERFORM private.notif_enqueue('playoff_seeding',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('leagueSeasonId',NEW.id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_matchup_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  v_loser uuid;
BEGIN
  IF OLD.is_finalized OR NOT NEW.is_finalized OR NEW.is_voided OR NEW.matchup_type = 'regular_season' OR NEW.winner_member_id IS NULL THEN RETURN NEW; END IF;
  v_loser := CASE WHEN NEW.winner_member_id = NEW.home_member_id THEN NEW.away_member_id ELSE NEW.home_member_id END;
  PERFORM private.notif_enqueue('playoff_eliminated',NEW.id::text,NEW.league_id,v_loser,jsonb_build_object('matchupId',NEW.id));
  IF NEW.matchup_type = 'playoff_final' THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
      PERFORM private.notif_enqueue('champion',NEW.league_season_id::text,NEW.league_id,m.id,
        jsonb_build_object('matchupId',NEW.id,'winnerMemberId',NEW.winner_member_id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_league_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  v_occurrence text := NEW.id::text || ':' || gen_random_uuid()::text;
  v_ignored text[] := ARRAY['id','created_at','updated_at','status','deleted_at','deleted_by','invite_code','slug'];
BEGIN
  IF (to_jsonb(OLD) - v_ignored) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_ignored) THEN RETURN NEW; END IF;
  FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.id LOOP
    PERFORM private.notif_enqueue('league_settings_changed',v_occurrence,NEW.id,m.id,jsonb_build_object('leagueId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_league_trade_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status <> 'completed' THEN RETURN NEW; END IF;
  FOR m IN SELECT id FROM public.league_members member WHERE league_id = NEW.league_id
    AND NOT EXISTS (SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id = NEW.id AND participant.member_id = member.id)
  LOOP
    PERFORM private.notif_enqueue('league_trade',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('tradeId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_scan_due_atomic(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_today date := (p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  FOR r IN SELECT pick.id,pick.member_id,draft.league_id,draft.id AS draft_id
    FROM public.snake_draft_picks pick JOIN public.drafts draft ON draft.id = pick.draft_id
    WHERE draft.status = 'in_progress' AND NOT draft.is_mock AND pick.picked_at IS NULL AND pick.skipped_at IS NULL
      AND pick.timer_expires_at > p_now AND pick.timer_expires_at <= p_now + interval '1 minute'
  LOOP
    PERFORM private.notif_enqueue('draft_timer_expiring',r.id::text,r.league_id,r.member_id,jsonb_build_object('draftId',r.draft_id,'pickId',r.id));
  END LOOP;
  FOR r IN SELECT season.id,season.league_id,member.id AS member_id FROM public.league_seasons season
    JOIN public.league_members member ON member.league_id = season.league_id
    JOIN public.leagues league ON league.id = season.league_id
    WHERE season.is_current AND league.status = 'active'
      AND v_today >= season.regular_season_start AND v_today < season.regular_season_start + 1
  LOOP
    PERFORM private.notif_enqueue('season_started',r.id::text,r.league_id,r.member_id,jsonb_build_object('leagueSeasonId',r.id));
  END LOOP;
  FOR r IN SELECT season.id,season.league_id,member.id AS member_id FROM public.league_seasons season
    JOIN public.leagues league ON league.id = season.league_id
    JOIN public.league_members member ON member.league_id = season.league_id
    WHERE season.is_current AND league.status = 'active'
      AND private.trade_deadline_for_season(league.trade_deadline,season.season_year) > v_today
      AND private.trade_deadline_for_season(league.trade_deadline,season.season_year) <= v_today + 3
  LOOP
    PERFORM private.notif_enqueue('trade_deadline_approaching',r.id::text,r.league_id,r.member_id,jsonb_build_object('leagueSeasonId',r.id));
  END LOOP;
  FOR r IN SELECT matchup.*,calendar.week_start,calendar.week_end FROM public.matchups matchup
    JOIN public.league_seasons season ON season.id = matchup.league_season_id AND season.is_current
    JOIN public.season_weeks calendar ON calendar.season_year = season.season_year AND calendar.week_number = matchup.week_number
    WHERE NOT matchup.is_finalized AND NOT matchup.is_voided
      AND v_today BETWEEN calendar.week_start AND calendar.week_end
      AND NOT matchup.week_number = ANY(season.skipped_weeks)
  LOOP
    PERFORM private.notif_enqueue('matchup_started',r.id::text,r.league_id,r.home_member_id,jsonb_build_object('matchupId',r.id));
    PERFORM private.notif_enqueue('matchup_started',r.id::text,r.league_id,r.away_member_id,jsonb_build_object('matchupId',r.id));
    IF v_today = r.week_end AND r.home_points IS NOT NULL AND r.away_points IS NOT NULL
      AND abs(r.home_points-r.away_points) <= greatest(10,(r.home_points+r.away_points)*0.025) THEN
      PERFORM private.notif_enqueue('matchup_close',r.id::text,r.league_id,r.home_member_id,jsonb_build_object('matchupId',r.id));
      PERFORM private.notif_enqueue('matchup_close',r.id::text,r.league_id,r.away_member_id,jsonb_build_object('matchupId',r.id));
    END IF;
  END LOOP;
END;
$$;
CREATE TRIGGER notif_draft_trigger AFTER INSERT OR UPDATE OF status ON public.drafts FOR EACH ROW EXECUTE FUNCTION private.notif_draft_trigger();
CREATE TRIGGER notif_pick_trigger AFTER INSERT OR UPDATE OF timer_expires_at,picked_at,skipped_at ON public.snake_draft_picks FOR EACH ROW EXECUTE FUNCTION private.notif_pick_trigger();
CREATE TRIGGER notif_draft_audit_trigger AFTER INSERT ON public.draft_audit_logs FOR EACH ROW EXECUTE FUNCTION private.notif_draft_audit_trigger();
CREATE TRIGGER notif_waiver_trigger AFTER UPDATE OF status ON public.waiver_claims FOR EACH ROW EXECUTE FUNCTION private.notif_waiver_trigger();
CREATE TRIGGER notif_player_trigger AFTER UPDATE OF injury_status ON public.players FOR EACH ROW EXECUTE FUNCTION private.notif_player_trigger();
CREATE TRIGGER notif_weekly_limit_trigger AFTER INSERT OR UPDATE OF add_count ON public.weekly_add_counts FOR EACH ROW EXECUTE FUNCTION private.notif_weekly_limit_trigger();
CREATE TRIGGER notif_season_trigger AFTER INSERT OR UPDATE OF playoff_seed_member_ids ON public.league_seasons FOR EACH ROW EXECUTE FUNCTION private.notif_season_trigger();
CREATE TRIGGER notif_matchup_trigger AFTER UPDATE OF is_finalized ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.notif_matchup_trigger();
CREATE TRIGGER notif_league_trigger AFTER UPDATE ON public.leagues FOR EACH ROW EXECUTE FUNCTION private.notif_league_trigger();
CREATE TRIGGER notif_league_trade_trigger AFTER UPDATE OF status ON public.trades FOR EACH ROW EXECUTE FUNCTION private.notif_league_trade_trigger();


REVOKE ALL ON FUNCTION private.notif_enqueue(text,text,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_draft_clock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_draft_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_pick_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_draft_audit_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_waiver_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_player_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_weekly_limit_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_season_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_matchup_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_league_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.notif_league_trade_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notif_scan_due_atomic(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_scan_due_atomic(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.invoke_process_trades_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= now()
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
  END IF;
END;
$$;

RESET statement_timeout;
RESET lock_timeout;
