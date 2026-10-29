BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
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
  FOR r IN WITH starting AS MATERIALIZED (
    SELECT season.id,season.league_id FROM public.league_seasons season
    JOIN public.leagues league ON league.id = season.league_id
    JOIN LATERAL (
      SELECT week.week_start,week.week_end FROM public.season_weeks week
      WHERE week.season_year=season.season_year AND NOT week.week_number=ANY(season.skipped_weeks)
      ORDER BY week.week_number LIMIT 1
    ) first_week ON true
    WHERE season.is_current AND league.status = 'active'
      AND v_today = CASE WHEN v_today BETWEEN first_week.week_start AND first_week.week_end
        THEN private.notif_first_scoring_day(season.id) END
  ) SELECT starting.id,starting.league_id,member.id AS member_id FROM starting
    JOIN public.league_members member ON member.league_id = starting.league_id
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
COMMIT;
