-- Canonical SQL source for private.scan_notification_member.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.scan_notification_member(p_member_id uuid,p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE member record; candidate record; first_day date; today date:=(p_now AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT m.id,m.league_id,league.status,league.trade_deadline,season.id AS season_id,season.season_year
    INTO member FROM public.league_members m JOIN public.leagues league ON league.id=m.league_id AND league.deleted_at IS NULL
    LEFT JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current WHERE m.id=p_member_id;
  IF NOT FOUND THEN RETURN; END IF;
  FOR candidate IN SELECT pick.id,draft.id AS draft_id FROM public.snake_draft_picks pick
    JOIN public.drafts draft ON draft.id=pick.draft_id
    WHERE pick.member_id=p_member_id AND draft.status='in_progress' AND NOT draft.is_mock
      AND pick.picked_at IS NULL AND pick.skipped_at IS NULL
      AND pick.timer_expires_at>p_now AND pick.timer_expires_at<=p_now+interval '1 minute'
  LOOP
    PERFORM private.notif_enqueue('draft_timer_expiring',candidate.id::text,member.league_id,p_member_id,
      jsonb_build_object('draftId',candidate.draft_id,'pickId',candidate.id));
  END LOOP;
  IF member.season_id IS NULL THEN RETURN; END IF;
  IF member.status IN('active','playoffs') AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.game_date=today
      AND private.lineup_game_available(game.status,game.game_status_text) AND game.game_time<=p_now+interval '2 hours')
    AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.game_date=today
      AND private.lineup_game_available(game.status,game.game_status_text) AND game.status='Scheduled' AND game.game_time>p_now
      AND (game.started_at IS NULL OR game.started_at>p_now)) THEN
    FOR candidate IN SELECT * FROM private.notif_lineup_candidates_scoped(p_now,member.league_id,p_member_id) LOOP
      PERFORM private.notif_enqueue(candidate.event_type,candidate.league_id||':'||candidate.game_date||COALESCE(':'||candidate.player_id,''),
        candidate.league_id,candidate.member_id,jsonb_build_object('memberId',candidate.member_id,'gameDate',candidate.game_date,'playerId',candidate.player_id));
    END LOOP;
  END IF;
  IF member.status='active' THEN
    SELECT cached.first_day INTO first_day FROM private.notification_season_scan_cache cached
      WHERE cached.season_id=member.season_id AND cached.cycle=(SELECT cycle FROM private.notification_scan_state WHERE id);
    IF NOT FOUND THEN
      SELECT CASE WHEN today BETWEEN week.week_start AND week.week_end THEN private.notif_first_scoring_day(member.season_id) END
        INTO first_day FROM public.season_weeks week JOIN public.league_seasons season ON season.id=member.season_id
        WHERE week.season_year=member.season_year AND NOT week.week_number=ANY(season.skipped_weeks)
        ORDER BY week.week_number LIMIT 1;
      INSERT INTO private.notification_season_scan_cache(season_id,cycle,first_day)
        SELECT member.season_id,cycle,first_day FROM private.notification_scan_state WHERE id
      ON CONFLICT(season_id) DO UPDATE SET cycle=EXCLUDED.cycle,first_day=EXCLUDED.first_day;
    END IF;
    IF today=first_day THEN
      PERFORM private.notif_enqueue('season_started',member.season_id::text,member.league_id,p_member_id,
        jsonb_build_object('leagueSeasonId',member.season_id));
    END IF;
    IF private.trade_deadline_for_season(member.trade_deadline,member.season_year)>today
      AND private.trade_deadline_for_season(member.trade_deadline,member.season_year)<=today+3 THEN
      PERFORM private.notif_enqueue('trade_deadline_approaching',member.season_id::text,member.league_id,p_member_id,
        jsonb_build_object('leagueSeasonId',member.season_id));
    END IF;
  END IF;
  FOR candidate IN SELECT matchup.*,ending.week_end FROM public.matchups matchup
    JOIN public.season_weeks first_week ON first_week.season_year=member.season_year AND first_week.week_number=matchup.week_number
    JOIN public.season_weeks ending ON ending.season_year=member.season_year AND ending.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    JOIN public.league_seasons season ON season.id=member.season_id
    WHERE matchup.league_season_id=member.season_id AND p_member_id IN(matchup.home_member_id,matchup.away_member_id)
      AND NOT matchup.is_finalized AND NOT matchup.is_voided AND today BETWEEN first_week.week_start AND ending.week_end
      AND NOT matchup.week_number=ANY(season.skipped_weeks)
  LOOP
    PERFORM private.notif_enqueue('matchup_started',candidate.id::text,member.league_id,p_member_id,jsonb_build_object('matchupId',candidate.id));
    IF today=candidate.week_end AND candidate.home_points IS NOT NULL AND candidate.away_points IS NOT NULL
      AND abs(candidate.home_points-candidate.away_points)<=greatest(10,(candidate.home_points+candidate.away_points)*0.025) THEN
      PERFORM private.notif_enqueue('matchup_close',candidate.id::text,member.league_id,p_member_id,jsonb_build_object('matchupId',candidate.id));
    END IF;
  END LOOP;
END;
$$;
