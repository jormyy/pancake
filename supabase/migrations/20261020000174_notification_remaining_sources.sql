CREATE TABLE public.player_watches (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(member_id,player_id)
);
CREATE INDEX player_watches_player_league ON public.player_watches(player_id,league_id);
ALTER TABLE public.player_watches ENABLE ROW LEVEL SECURITY;
CREATE POLICY notif_watch_own_read ON public.player_watches FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL
    WHERE m.id=member_id AND m.league_id=player_watches.league_id AND m.user_id=(SELECT auth.uid()))
);
REVOKE ALL ON public.player_watches FROM anon,authenticated;
GRANT SELECT ON public.player_watches TO authenticated;
GRANT ALL ON public.player_watches TO service_role;
CREATE TABLE public.league_announcements (
  id uuid PRIMARY KEY,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  author_member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 500),
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX league_announcements_published ON public.league_announcements(league_id,published_at DESC);
ALTER TABLE public.league_announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY notif_announcement_member_read ON public.league_announcements FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL
    WHERE m.league_id=league_announcements.league_id AND m.user_id=(SELECT auth.uid()))
);
REVOKE ALL ON public.league_announcements FROM anon,authenticated;
GRANT SELECT ON public.league_announcements TO authenticated;
GRANT ALL ON public.league_announcements TO service_role;
CREATE OR REPLACE FUNCTION private.notif_player_games(p_player uuid,p_date date)
RETURNS SETOF public.nba_games
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH participation AS (
    SELECT game_id FROM public.player_game_stats WHERE player_id=p_player
    UNION SELECT game_id FROM private.player_game_memberships WHERE player_id=p_player
  )
  SELECT g.* FROM public.nba_games g JOIN public.players p ON p.id=p_player
  WHERE g.game_date=p_date AND (
    ((g.home_team=p.nba_team OR g.away_team=p.nba_team) AND NOT EXISTS (
      SELECT 1 FROM participation x JOIN public.nba_games actual ON actual.id=x.game_id WHERE actual.game_date=p_date))
    OR EXISTS(SELECT 1 FROM participation x WHERE x.game_id=g.id)
  );
$$;

CREATE OR REPLACE FUNCTION private.notif_lineup_candidates(p_now timestamptz DEFAULT now())
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH day AS (SELECT (p_now AT TIME ZONE 'America/New_York')::date AS date),
  members AS (
    SELECT m.id,m.league_id,s.id AS season_id,day.date FROM public.league_members m
    JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL AND l.status IN ('active','playoffs')
    JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current CROSS JOIN day
    WHERE EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=day.date AND g.season_year=s.season_year
      AND private.lineup_game_available(g.status,g.game_status_text) AND g.game_time<=p_now+interval '2 hours')
      AND EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=day.date AND g.season_year=s.season_year
      AND private.lineup_game_available(g.status,g.game_status_text) AND g.status='Scheduled' AND g.game_time>p_now
      AND (g.started_at IS NULL OR g.started_at>p_now))
  )
  SELECT 'lineup_inactive'::text,m.league_id,m.id,p.id,m.date FROM members m
  JOIN public.weekly_lineups w ON w.member_id=m.id AND w.league_id=m.league_id AND w.league_season_id=m.season_id AND w.game_date=m.date
  JOIN public.roster_players r ON r.member_id=m.id AND r.league_id=m.league_id AND r.league_season_id=m.season_id AND r.player_id=w.player_id
  JOIN public.players p ON p.id=w.player_id
  WHERE w.slot_type NOT IN ('BE','IR') AND NOT r.is_on_ir AND NOT r.is_on_taxi
    AND NOT private.lineup_game_started(p.id,m.date) AND NOT private.roster_status_game_started(p.id)
    AND (lower(COALESCE(p.injury_status,'')) IN ('out','inactive','suspended')
      OR lower(COALESCE(p.status,'')) IN ('out','inactive','suspended')
      OR NOT EXISTS(SELECT 1 FROM private.notif_player_games(p.id,m.date) g WHERE private.lineup_game_available(g.status,g.game_status_text)))
  UNION
  SELECT 'lineup_empty'::text,m.league_id,m.id,NULL::uuid,m.date FROM members m
  WHERE EXISTS(
    SELECT 1 FROM public.lineup_slot_templates slot WHERE slot.league_id=m.league_id AND slot.slot_type NOT IN ('BE','IR')
      AND slot.slot_count>(SELECT count(*) FROM public.weekly_lineups w WHERE w.member_id=m.id AND w.league_id=m.league_id
        AND w.league_season_id=m.season_id AND w.game_date=m.date AND w.slot_type=slot.slot_type)
      AND EXISTS(
        SELECT 1 FROM public.roster_players r JOIN public.players p ON p.id=r.player_id
        WHERE r.member_id=m.id AND r.league_id=m.league_id AND r.league_season_id=m.season_id AND NOT r.is_on_ir AND NOT r.is_on_taxi
          AND (CASE WHEN cardinality(p.eligible_positions)>0 THEN p.eligible_positions
            ELSE ARRAY[p.position::text] END
            && public.lineup_slot_allowed_positions(slot.slot_type))
          AND NOT private.lineup_game_started(p.id,m.date) AND NOT private.roster_status_game_started(p.id)
          AND EXISTS(SELECT 1 FROM private.notif_player_games(p.id,m.date) g WHERE private.lineup_game_available(g.status,g.game_status_text)
            AND g.status='Scheduled' AND g.game_time>p_now AND (g.started_at IS NULL OR g.started_at>p_now))
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.notif_scan_lineups(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM private.notif_lineup_candidates(p_now) LOOP
    PERFORM private.notif_enqueue(r.event_type,r.league_id || ':' || r.game_date || COALESCE(':' || r.player_id,''),r.league_id,r.member_id,
      jsonb_build_object('memberId',r.member_id,'gameDate',r.game_date,'playerId',r.player_id));
  END LOOP;
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
  PERFORM private.notif_scan_lineups(p_now);
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
  FOR r IN SELECT matchup.*,calendar.week_start,ending.week_end FROM public.matchups matchup
    JOIN public.league_seasons season ON season.id = matchup.league_season_id AND season.is_current
    JOIN public.season_weeks calendar ON calendar.season_year = season.season_year AND calendar.week_number = matchup.week_number
    JOIN public.season_weeks ending ON ending.season_year = season.season_year AND ending.week_number = COALESCE(matchup.end_week_number,matchup.week_number)
    WHERE NOT matchup.is_finalized AND NOT matchup.is_voided
      AND v_today BETWEEN calendar.week_start AND ending.week_end
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
  IF NOT (p_data ? 'draftId' AND p_data ? 'pickId') THEN RETURN true; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
  IF d.id IS NULL OR d.is_mock OR d.status <> 'in_progress' THEN RETURN true; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE id::text = p_data->>'pickId' AND draft_id = d.id;
  IF p.id IS NULL OR p.picked_at IS NOT NULL OR p.skipped_at IS NOT NULL THEN RETURN true; END IF;
  SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
    WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  RETURN deadline IS NULL OR deadline <= clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_set_player_watch_atomic(p_league_id uuid,p_player_id uuid,p_enabled boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m uuid;
BEGIN
  SELECT member.id INTO m FROM public.league_members member JOIN public.leagues l ON l.id=member.league_id AND l.deleted_at IS NULL
    WHERE member.league_id=p_league_id AND member.user_id=(SELECT auth.uid());
  IF m IS NULL THEN RAISE EXCEPTION 'League membership required' USING ERRCODE='42501'; END IF;
  IF p_enabled IS NULL OR NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id) THEN RAISE EXCEPTION 'Player and watch choice required' USING ERRCODE='22023'; END IF;
  IF p_enabled THEN
    INSERT INTO public.player_watches(league_id,member_id,player_id) VALUES(p_league_id,m,p_player_id) ON CONFLICT(member_id,player_id) DO NOTHING;
  ELSE DELETE FROM public.player_watches WHERE league_id=p_league_id AND member_id=m AND player_id=p_player_id;
  END IF;
  RETURN p_enabled;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_watch_drop_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE watcher record;
BEGIN
  FOR watcher IN SELECT w.member_id FROM public.player_watches w JOIN public.league_members m ON m.id=w.member_id AND m.league_id=w.league_id
    WHERE w.league_id=NEW.league_id AND w.player_id=NEW.player_id AND w.member_id IS DISTINCT FROM NEW.dropped_by_member_id
  LOOP
    PERFORM private.notif_enqueue('watched_player_dropped',NEW.id::text,NEW.league_id,watcher.member_id,
      jsonb_build_object('playerId',NEW.player_id,'waiverLogId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_publish_announcement_atomic(p_league_id uuid,p_body text,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m uuid; saved public.league_announcements%ROWTYPE; body text:=btrim(p_body);
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN RAISE EXCEPTION 'Commissioner access required' USING ERRCODE='42501'; END IF;
  IF body IS NULL OR length(body) NOT BETWEEN 1 AND 500 OR p_request_id IS NULL THEN RAISE EXCEPTION 'Announcement must contain 1 to 500 characters' USING ERRCODE='22023'; END IF;
  SELECT id INTO m FROM public.league_members WHERE league_id=p_league_id AND user_id=(SELECT auth.uid());
  INSERT INTO public.league_announcements(id,league_id,author_member_id,body) VALUES(p_request_id,p_league_id,m,body) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO saved FROM public.league_announcements WHERE id=p_request_id;
  IF saved.league_id<>p_league_id OR saved.author_member_id<>m OR saved.body<>body THEN RAISE EXCEPTION 'Announcement request already used' USING ERRCODE='23505'; END IF;
  RETURN saved.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_list_announcements(p_league_id uuid)
RETURNS SETOF public.league_announcements LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL
    WHERE m.league_id=p_league_id AND m.user_id=(SELECT auth.uid())) THEN RAISE EXCEPTION 'League membership required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT * FROM public.league_announcements WHERE league_id=p_league_id ORDER BY published_at DESC,id DESC LIMIT 50;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_announcement_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members WHERE id=NEW.author_member_id AND league_id=NEW.league_id AND role IN ('commissioner','co_commissioner')) THEN
    RAISE EXCEPTION 'Commissioner author required' USING ERRCODE='42501';
  END IF;
  FOR m IN SELECT id FROM public.league_members WHERE league_id=NEW.league_id AND id<>NEW.author_member_id LOOP
    PERFORM private.notif_enqueue('commissioner_announcement',NEW.id::text,NEW.league_id,m.id,
      jsonb_build_object('announcementId',NEW.id,'body',NEW.body));
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notif_watched_player_dropped AFTER INSERT ON public.waiver_wire_log FOR EACH ROW EXECUTE FUNCTION private.notif_watch_drop_trigger();
CREATE TRIGGER notif_commissioner_announcement AFTER INSERT ON public.league_announcements FOR EACH ROW EXECUTE FUNCTION private.notif_announcement_trigger();
REVOKE ALL ON FUNCTION public.notif_set_player_watch_atomic(uuid,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notif_set_player_watch_atomic(uuid,uuid,boolean) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.notif_publish_announcement_atomic(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notif_publish_announcement_atomic(uuid,text,uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.notif_list_announcements(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.notif_list_announcements(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION private.notif_player_games(uuid,date) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.notif_lineup_candidates(timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.notif_scan_lineups(timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.notif_watch_drop_trigger() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.notif_announcement_trigger() FROM PUBLIC,anon,authenticated;
