-- Canonical SQL source for private.enqueue_pre_tipoff_optimizer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_pre_tipoff_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_window record; v_fingerprint text; v_today date:=(p_now AT TIME ZONE 'America/New_York')::date; v_attempt int;
BEGIN
  FOR v_window IN
    SELECT tipoff_at, league_id FROM (
    SELECT DISTINCT g.game_time AS tipoff_at, NULL::uuid AS league_id
      FROM public.nba_games g
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > p_now
       AND g.game_time <= p_now + interval '2 minutes'
       AND (g.started_at IS NULL OR g.started_at > p_now)
       AND EXISTS (
         SELECT 1 FROM public.lineup_optimizer_settings s
         JOIN public.league_seasons ls ON ls.id = s.league_season_id
         JOIN public.leagues l ON l.id = s.league_id
         WHERE s.enabled AND ls.is_current AND ls.season_year = g.season_year
           AND l.status IN ('active', 'playoffs')
           AND NOT private.league_auto_ir_all_members(s.league_id)
       )
    UNION
    SELECT DISTINCT g.game_time AS tipoff_at, policy.league_id
      FROM public.nba_games g
      JOIN public.league_seasons ls ON ls.season_year = g.season_year AND ls.is_current
      JOIN public.leagues l ON l.id = ls.league_id AND l.status IN ('active', 'playoffs')
      JOIN private.league_roster_policies policy ON policy.league_id = l.id
        AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
     WHERE g.game_date = v_today
       AND g.status = 'Scheduled'
       AND private.lineup_game_available(g.status, g.game_status_text)
       AND g.game_time > p_now
       AND g.game_time <= p_now + interval '2 minutes'
       AND (g.started_at IS NULL OR g.started_at > p_now)
    UNION
    SELECT d.tipoff_at, NULLIF(d.scope,'')::uuid
      FROM public.lineup_tipoff_dispatches d
     WHERE d.game_date = v_today AND d.tipoff_at > p_now - interval '1 minute'
       AND d.tipoff_at <= p_now + interval '2 minutes'
    ) windows ORDER BY tipoff_at, league_id NULLS FIRST
  LOOP
    IF v_window.league_id IS NULL THEN
      v_fingerprint := private.pre_tipoff_input_fingerprint(v_today);
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope='' AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at;
      PERFORM private.work_enqueue('pre-tipoff',v_window.tipoff_at::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'fingerprint',v_fingerprint));
    ELSE
      IF NOT private.league_auto_ir_all_members(v_window.league_id) THEN CONTINUE; END IF;
      v_fingerprint := private.pre_tipoff_policy_input_fingerprint(v_today, v_window.league_id);
      IF EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_window.tipoff_at AND scope=v_window.league_id::text AND ((status='succeeded' AND input_fingerprint=v_fingerprint) OR (status IN ('queued','running') AND lease_until>p_now))) THEN CONTINUE; END IF;
      SELECT count(*) INTO v_attempt FROM private.work_items item
       WHERE item.kind='pre-tipoff-policy' AND (item.payload->>'tipoffAt')::timestamptz=v_window.tipoff_at AND item.payload->>'leagueId'=v_window.league_id::text;
      PERFORM private.work_enqueue('pre-tipoff-policy',v_window.tipoff_at::text||':'||v_window.league_id::text||':'||v_fingerprint||':'||v_attempt::text,p_now,
        jsonb_build_object('mode','pre_tipoff','tipoffAt',v_window.tipoff_at,'leagueId',v_window.league_id,'fingerprint',v_fingerprint));
    END IF;
  END LOOP;
END;
$$;
