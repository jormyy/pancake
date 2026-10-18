BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.compute_fantasy_points(
  p_stat_id   uuid,
  p_league_id uuid
)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_settings jsonb;
  v_stats    public.player_game_stats%ROWTYPE;
  v_total    numeric := 0;
BEGIN
  SELECT scoring_settings INTO v_settings
    FROM public.leagues WHERE id = p_league_id;

  SELECT pgs.* INTO v_stats
    FROM public.player_game_stats pgs
    INNER JOIN public.nba_games g ON g.id = pgs.game_id
    WHERE pgs.id = p_stat_id
      AND public.is_regular_season_game_id(g.nba_game_id);

  IF NOT FOUND OR v_stats.did_not_play THEN
    RETURN 0;
  END IF;

  v_total :=
    COALESCE(v_stats.points,                  0) * COALESCE((v_settings->>'points')::numeric,                0) +
    COALESCE(v_stats.rebounds,                0) * COALESCE((v_settings->>'rebounds')::numeric,              0) +
    COALESCE(v_stats.assists,                 0) * COALESCE((v_settings->>'assists')::numeric,               0) +
    COALESCE(v_stats.steals,                  0) * COALESCE((v_settings->>'steals')::numeric,                0) +
    COALESCE(v_stats.blocks,                  0) * COALESCE((v_settings->>'blocks')::numeric,                0) +
    COALESCE(v_stats.turnovers,               0) * COALESCE((v_settings->>'turnovers')::numeric,             0) +
    COALESCE(v_stats.three_pointers_made,     0) * COALESCE((v_settings->>'three_pointers_made')::numeric,   0) +
    COALESCE(v_stats.field_goals_made,        0) * COALESCE((v_settings->>'field_goals_made')::numeric,      0) +
    COALESCE(v_stats.field_goals_attempted,   0) * COALESCE((v_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(v_stats.free_throws_made,        0) * COALESCE((v_settings->>'free_throws_made')::numeric,      0) +
    COALESCE(v_stats.free_throws_attempted,   0) * COALESCE((v_settings->>'free_throws_attempted')::numeric, 0) +
    CASE WHEN v_stats.double_double = true
      THEN COALESCE((v_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN v_stats.triple_double = true
      THEN COALESCE((v_settings->>'triple_double')::numeric, 0) ELSE 0 END;

  RETURN ROUND(v_total, 2);
END;
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_reset_label(p_resets_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- "Mon, Nov 2 at 12:00 AM ET": the one rendering of the reset boundary, shown by
  -- the rejection message and by every client surface.
  SELECT CASE
           WHEN p_resets_at IS NULL THEN NULL
           ELSE to_char(p_resets_at AT TIME ZONE private.add_week_timezone(), 'Dy, Mon FMDD "at" FMHH12:MI AM') || ' ET'
         END;
$$;

CREATE OR REPLACE FUNCTION private.reserved_trade_asset_message()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 'This asset is reserved by an accepted trade.'
$$;

CREATE OR REPLACE FUNCTION private.assert_not_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF private.is_reserved_trade_asset(p_league_id, p_league_season_id, p_member_id, p_player_id, p_pick_id, p_exclude_trade_id) THEN
    RAISE EXCEPTION '%', private.reserved_trade_asset_message() USING ERRCODE = 'PA004';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.pick_left_owner(
  p_old draft_picks,
  p_new draft_picks
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  -- How a pick left its owner's hands: 'used' in a draft, 'owner' when it
  -- changed hands, NULL when it did not leave.
  SELECT CASE
           WHEN p_new.is_used = true AND p_old.is_used IS DISTINCT FROM p_new.is_used THEN 'used'
           WHEN p_old.current_owner_id IS DISTINCT FROM p_new.current_owner_id THEN 'owner'
         END
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_reached(p_used int, p_limit int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_limit IS NOT NULL AND COALESCE(p_used, 0) >= p_limit
$$;

CREATE OR REPLACE FUNCTION private.is_ir_designation(p_injury_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(COALESCE(p_injury_status, '')) = 'out'
      OR lower(COALESCE(p_injury_status, '')) LIKE 'ir%'
$$;

CREATE OR REPLACE FUNCTION private.lineup_game_available(p_status text, p_status_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT p_status IN ('Scheduled', 'InProgress', 'Final')
    AND COALESCE(p_status_text, '') !~* 'postpon|cancel|suspend|(^|[^a-z])ppd([^a-z]|$)';
$$;

CREATE OR REPLACE FUNCTION private.playoff_seed_order(p_size bigint)
RETURNS bigint[] LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE v_order bigint[]:=ARRAY[1::bigint,2::bigint]; v_next bigint[]; v_size bigint:=2; v_seed bigint;
BEGIN
  WHILE v_size<p_size LOOP
    v_size:=v_size*2;
    v_next:='{}';
    FOREACH v_seed IN ARRAY v_order LOOP
      v_next:=v_next||ARRAY[v_seed,v_size+1-v_seed];
    END LOOP;
    v_order:=v_next;
  END LOOP;
  RETURN v_order;
END;
$$;

CREATE OR REPLACE FUNCTION private.add_week_timezone()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 'America/New_York'::text
$$;

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- The rejection sentence while the week's adds are used up, NULL otherwise.
  SELECT CASE
           WHEN private.weekly_add_limit_reached(p_used, p_limit)
           THEN format('Weekly add limit reached (%s/%s adds used this week).', COALESCE(p_used, 0), p_limit)
             || COALESCE(format(' Adds reset %s.', private.weekly_add_limit_reset_label(p_resets_at)), '')
         END;
$$;

CREATE OR REPLACE FUNCTION private.trade_lifecycle_write_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT current_setting('app.trade_lifecycle_server_write', true) = 'on'
$$;

CREATE OR REPLACE FUNCTION private.begin_trade_lifecycle_write()
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.trade_lifecycle_server_write', true), '');
BEGIN
  -- Marks the transaction as server-owned trade lifecycle work so the status
  -- and reservation guards let it through; returns the value to restore.
  PERFORM set_config('app.trade_lifecycle_server_write', 'on', true);
  RETURN v_previous;
END;
$$;

CREATE OR REPLACE FUNCTION private.end_trade_lifecycle_write(
  p_previous text
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT set_config('app.trade_lifecycle_server_write', COALESCE(p_previous, ''), true)
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_assignments) > 64 THEN
    RAISE EXCEPTION 'Too many lineup assignments.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.auto_set_lineup_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM public.league_members
  WHERE id = p_member_id AND league_id = p_league_id AND user_id = auth.uid()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_moves) > 64 THEN
    RAISE EXCEPTION 'Too many lineup moves.'
      USING ERRCODE = '22023';
  END IF;

  IF p_game_date < (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM private.assert_roster_within_active_limit(p_league_id, p_league_season_id, p_member_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END;
$$;

ALTER POLICY taxi_exit_league_read ON public.league_player_taxi_exits
  USING (EXISTS (SELECT 1 FROM public.league_members m
    WHERE m.league_id = league_player_taxi_exits.league_id AND m.user_id = (SELECT auth.uid())));
ALTER POLICY taxi_exit_team_league_read ON public.league_member_taxi_exits
  USING (EXISTS (SELECT 1 FROM public.league_members m
    WHERE m.league_id = league_member_taxi_exits.league_id AND m.user_id = (SELECT auth.uid())));
COMMIT;
