CREATE TABLE private.roster_floor_weeks (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  week_number int NOT NULL,
  week_end date NOT NULL,
  team_order uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
  completed_at timestamptz,
  last_deferral_reason text,
  last_deferred_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, league_season_id, week_number)
);
ALTER TABLE private.roster_floor_weeks OWNER TO postgres;
ALTER TABLE private.roster_floor_weeks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.roster_floor_weeks FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.roster_floor_awards (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  week_number int NOT NULL,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, league_season_id, week_number, player_id)
);
ALTER TABLE private.roster_floor_awards OWNER TO postgres;
ALTER TABLE private.roster_floor_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.roster_floor_awards FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
('private.roster_floor_weeks','One row per league, season, and week; league deletion cascades'),
('private.roster_floor_awards','One award per player and week; league deletion cascades')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule;

INSERT INTO private.work_kinds(kind, function_name) VALUES ('roster-floor', 'process-waivers')
ON CONFLICT (kind) DO UPDATE SET function_name = EXCLUDED.function_name;

-- Canonical SQL source for private.roster_floor_week_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE TABLE private.waiver_run_settlements (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  process_date date NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, league_season_id, process_date)
);
ALTER TABLE private.waiver_run_settlements OWNER TO postgres;
ALTER TABLE private.waiver_run_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.waiver_run_settlements FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule) VALUES
('private.waiver_run_settlements','One settlement per league, season, and process date; league deletion cascades')
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule;

CREATE OR REPLACE FUNCTION private.settle_waiver_runs(p_timezone text, p_date date, p_drain_started_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count int := 0;
BEGIN
  IF p_drain_started_at < (p_date + time '00:00') AT TIME ZONE p_timezone THEN
    RETURN 0;
  END IF;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
  SELECT league.id, season.id, p_date
    FROM public.leagues league
    JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
   WHERE COALESCE(league.timezone, 'America/Los_Angeles') = p_timezone
     AND league.status IN ('active', 'playoffs', 'offseason')
     AND NOT EXISTS (
       SELECT 1 FROM public.waiver_claims claim
        WHERE claim.league_id = league.id
          AND claim.league_season_id = season.id
          AND claim.status = 'pending'
          AND claim.process_date <= p_date
          AND NOT EXISTS (
            SELECT 1 FROM public.waiver_wire_log wire
             WHERE wire.league_id = claim.league_id
               AND wire.league_season_id = claim.league_season_id
               AND wire.player_id = claim.player_id
               AND wire.cleared_at IS NULL
               AND wire.clears_at > (p_date + time '00:00') AT TIME ZONE p_timezone
          )
     )
  ON CONFLICT (league_id, league_season_id, process_date) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_waiver_runs(p_timezone text, p_date date, p_drain_started_at timestamptz)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.settle_waiver_runs(p_timezone, p_date, p_drain_started_at);
$$;

CREATE OR REPLACE FUNCTION public.settle_latest_waiver_runs(p_drain_started_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count int := 0; v_row record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT COALESCE(league.timezone, 'America/Los_Angeles') AS timezone,
           (SELECT max(weeks.week_end)
              FROM public.season_weeks weeks
             WHERE weeks.season_year = season.season_year
               AND weeks.week_end <= (now() AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles'))::date) AS week_end
      FROM public.leagues league
      JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
     WHERE league.status IN ('active', 'playoffs', 'offseason')
  LOOP
    IF v_row.week_end IS NOT NULL THEN
      v_count := v_count + private.settle_waiver_runs(v_row.timezone, v_row.week_end, p_drain_started_at);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.roster_status_game_started_live(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  WITH slate AS (
    SELECT (clock_timestamp() AT TIME ZONE 'America/New_York')::date AS today
  ), recent_games AS MATERIALIZED (
    SELECT game.id, game.game_date, game.home_team, game.away_team,
      game.status, game.game_time, game.started_at
    FROM nba_games game CROSS JOIN slate
    WHERE game.game_date IN (slate.today - 1, slate.today)
  ), participation AS (
    SELECT game.id AS game_id
    FROM recent_games game
    WHERE EXISTS (
      SELECT 1 FROM player_game_stats stats
      WHERE stats.player_id = p_player_id AND stats.game_id = game.id
    ) OR EXISTS (
      SELECT 1 FROM private.player_game_memberships membership
      WHERE membership.player_id = p_player_id AND membership.game_id = game.id
    )
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN recent_games AS g ON (
        ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
          AND NOT EXISTS (
            SELECT 1 FROM participation AS observed
            JOIN recent_games AS actual ON actual.id = observed.game_id
            WHERE actual.game_date = g.game_date
          ))
        OR EXISTS (
          SELECT 1 FROM participation AS stats
          WHERE stats.game_id = g.id
        )
      )
      CROSS JOIN slate
     WHERE p.id = p_player_id
       AND g.game_date IN (slate.today - 1, slate.today)
       AND (
         g.status = 'InProgress'
         OR (g.game_date = slate.today AND g.status = 'Final')
         OR (g.game_time <= clock_timestamp() AND (g.game_date = slate.today OR g.game_time >= clock_timestamp() - interval '12 hours'))
         OR (g.started_at <= clock_timestamp() AND (g.game_date = slate.today OR g.started_at >= clock_timestamp() - interval '12 hours'))
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.roster_floor_player_legal(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.players player
      JOIN public.league_seasons season
        ON season.id = p_league_season_id
       AND season.league_id = p_league_id
      JOIN public.leagues league
        ON league.id = p_league_id
     WHERE player.id = p_player_id
       AND player.nba_team IS NOT NULL
       AND player.injury_status IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.roster_players roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.player_id = player.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_claims claim
          WHERE claim.league_id = p_league_id
            AND claim.league_season_id = p_league_season_id
            AND claim.player_id = player.id
            AND claim.status = 'pending'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_wire_log wire
          WHERE wire.league_id = p_league_id
            AND wire.league_season_id = p_league_season_id
            AND wire.player_id = player.id
            AND wire.cleared_at IS NULL
            AND wire.clears_at > clock_timestamp()
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.trades trade
           JOIN public.trade_items item ON item.trade_id = trade.id
          WHERE trade.league_id = p_league_id
            AND trade.league_season_id = p_league_season_id
            AND trade.status IN ('pending', 'accepted')
            AND item.player_id = player.id
       )
       AND NOT (
         league.status = 'offseason'
         AND player.years_exp = 0
         AND player.nba_draft_number IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.drafts draft
            WHERE draft.league_id = p_league_id
              AND draft.league_season_id = p_league_season_id
              AND draft.draft_type = 'snake'
              AND NOT draft.is_mock
              AND draft.status = 'completed'
         )
       )
       AND NOT private.roster_status_game_started_live(player.id)
  )
$$;

CREATE OR REPLACE FUNCTION private.pre_tipoff_input_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings,
      l.roster_size, l.ir_slots
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
    UNION
    SELECT member.league_id, season.id, member.id, season.season_year, league.scoring_settings,
      league.roster_size, league.ir_slots
    FROM public.league_members member
    JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
    JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
    JOIN private.league_roster_policies policy ON policy.league_id = league.id
      AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
    WHERE EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = season.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, p.injury_expected_return,
      p.career_regular_season_games, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'locks', (SELECT jsonb_agg(jsonb_build_array(t.league_id, t.member_id, la.asset_kind, la.asset_id,
        la.source_kind, la.source_id) ORDER BY t.league_id, t.member_id, la.asset_kind, la.asset_id)
      FROM teams t CROSS JOIN LATERAL private.locked_assets(t.league_id, t.league_season_id, t.member_id) la),
    'pins', (SELECT jsonb_agg(to_jsonb(pin) ORDER BY pin.league_id, pin.member_id, pin.player_id)
      FROM public.lineup_player_pins pin JOIN teams t ON t.league_id = pin.league_id
        AND t.league_season_id = pin.league_season_id AND t.member_id = pin.member_id
      WHERE pin.game_date = p_game_date),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;

CREATE OR REPLACE FUNCTION private.roster_floor_week_ready(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_week_end date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_zone text;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_run_at timestamptz;
BEGIN
  IF p_week_number IS NULL OR p_week_end IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'no_week');
  END IF;
  IF v_today > p_week_end AND EXISTS (
    SELECT 1
      FROM private.roster_floor_weeks week_row
     WHERE week_row.league_id = p_league_id
       AND week_row.league_season_id = p_league_season_id
       AND week_row.week_number = p_week_number
       AND week_row.status = 'completed'
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'week_ended');
  END IF;
  IF v_today < p_week_end THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'week_not_started');
  END IF;
  SELECT COALESCE(league.timezone, 'America/Los_Angeles')
    INTO v_zone
    FROM public.leagues league
   WHERE league.id = p_league_id;
  IF v_zone IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'league');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.floor_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'worker_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.ir_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'ir_pending');
  END IF;
  v_run_at := (p_week_end + time '00:00') AT TIME ZONE v_zone;
  IF v_run_at > now() THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'waiver_run_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.waiver_run_settlements settlement
     WHERE settlement.league_id = p_league_id
       AND settlement.league_season_id = p_league_season_id
       AND settlement.process_date = p_week_end
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'settlement_pending');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.waiver_claims claim
     WHERE claim.league_id = p_league_id
       AND claim.league_season_id = p_league_season_id
       AND claim.status = 'pending'
       AND claim.process_date <= p_week_end
       AND (claim.process_date + time '00:00') AT TIME ZONE v_zone <= now()
       AND NOT EXISTS (
         SELECT 1
           FROM public.waiver_wire_log wire
          WHERE wire.league_id = claim.league_id
            AND wire.league_season_id = claim.league_season_id
            AND wire.player_id = claim.player_id
            AND wire.cleared_at IS NULL
            AND wire.clears_at > (claim.process_date + time '00:00') AT TIME ZONE v_zone
       )
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'claims_pending');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.nba_games game
     WHERE game.game_date IN (v_today - 1, v_today)
       AND game.status IN ('Scheduled', 'InProgress')
       AND private.lineup_game_available(game.status, game.game_status_text)
       AND (
         game.status = 'InProgress'
         OR game.game_time <= now()
         OR game.started_at <= now()
       )
  ) THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'game_in_progress');
  END IF;
  RETURN jsonb_build_object('ready', true, 'reason', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION private.roster_floor_pool(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS TABLE(player_id uuid, avg_fantasy_points numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT player.id, average.avg_fantasy_points
    FROM public.players player
    JOIN public.league_seasons season
      ON season.id = p_league_season_id
     AND season.league_id = p_league_id
    JOIN public.leagues league
      ON league.id = p_league_id
    JOIN public.player_season_averages average
      ON average.league_id = p_league_id
     AND average.league_season_id = p_league_season_id
     AND average.season_year = season.season_year
     AND average.player_id = player.id
   WHERE average.avg_fantasy_points IS NOT NULL
     AND player.nba_team IS NOT NULL
     AND player.injury_status IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.roster_players roster
        WHERE roster.league_id = p_league_id
          AND roster.league_season_id = p_league_season_id
          AND roster.player_id = player.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.waiver_wire_log wire
        WHERE wire.league_id = p_league_id
          AND wire.league_season_id = p_league_season_id
          AND wire.player_id = player.id
          AND wire.cleared_at IS NULL
          AND wire.clears_at > now()
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.waiver_claims claim
        WHERE claim.league_id = p_league_id
          AND claim.league_season_id = p_league_season_id
          AND claim.player_id = player.id
          AND claim.status = 'pending'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.trades trade
         JOIN public.trade_items item ON item.trade_id = trade.id
        WHERE trade.league_id = p_league_id
          AND trade.league_season_id = p_league_season_id
          AND trade.status IN ('pending', 'accepted')
          AND item.player_id = player.id
     )
     AND NOT (
       league.status = 'offseason'
       AND player.years_exp = 0
       AND player.nba_draft_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.drafts draft
          WHERE draft.league_id = p_league_id
            AND draft.league_season_id = p_league_season_id
            AND draft.draft_type = 'snake'
            AND NOT draft.is_mock
            AND draft.status = 'completed'
       )
     )
     AND NOT private.roster_status_game_started_live(player.id)
   ORDER BY average.avg_fantasy_points DESC, player.id ASC
$$;

CREATE OR REPLACE FUNCTION public.auto_manage_ir_service(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_enabled boolean;
  v_league_auto_ir boolean;
  v_roster_size int;
  v_ir_slots int;
  v_ir_before int;
  v_active_before int;
  v_ir_after int;
  v_active_after int;
  v_user_id uuid;
  v_lock_id uuid;
  v_plan jsonb;
  v_move jsonb;
  v_kind text;
  v_swap_kind text;
  v_candidate_roster_id uuid;
  v_candidate_player_id uuid;
  v_occupant_roster_id uuid;
  v_occupant_player_id uuid;
  v_candidate_status text;
  v_candidate_return date;
  v_occupant_status text;
  v_occupant_return date;
  v_occupant_on_ir boolean;
  v_planned_contender_return date;
  v_planned_incumbent_return date;
  v_compared_player_id uuid;
  v_compared_return date;
  v_compared_on_ir boolean;
  v_moves jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_taxi_before jsonb;
  v_taxi_after jsonb;
  v_ids_before uuid[];
  v_ids_after uuid[];
  v_problems_before text[];
  v_problems_after text[];
  v_transient text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_member
    FROM league_members
   WHERE id = p_member_id AND league_id = p_league_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND
     OR v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM league_seasons
     WHERE id = p_league_season_id AND league_id = p_league_id AND is_current
  ) THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  v_user_id := v_member.user_id;
  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  FOR v_lock_id IN
    SELECT DISTINCT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_member_id
     ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_id::text));
  END LOOP;

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR SHARE;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('moves', '[]'::jsonb, 'skipped', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_before, v_active_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_before
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_before
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_before
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);

  v_plan := private.plan_auto_ir(p_league_id, p_league_season_id, p_member_id);
  v_skipped := COALESCE(v_plan->'skipped', '[]'::jsonb);
  v_notices := COALESCE(v_plan->'notices', '[]'::jsonb);

  FOR v_move IN SELECT * FROM jsonb_array_elements(COALESCE(v_plan->'moves', '[]'::jsonb)) LOOP
    v_kind := v_move->>'kind';
    IF v_league_auto_ir AND (
      (v_move ? 'designatePlayerId' AND private.roster_status_game_started_live((v_move->>'designatePlayerId')::uuid))
      OR (v_move ? 'activatePlayerId' AND private.roster_status_game_started_live((v_move->>'activatePlayerId')::uuid))
    ) THEN
      v_skipped := v_skipped || jsonb_build_object(
        'playerId', COALESCE(v_move->>'designatePlayerId', v_move->>'activatePlayerId'),
        'reason', 'game_started',
        'sqlstate', 'P0001'
      );
      CONTINUE;
    END IF;
    IF v_kind = 'designate' THEN
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
        PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, NULL);
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
        v_moves := v_moves || jsonb_build_object('kind', 'designate', 'designatePlayerId', v_candidate_player_id);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    ELSIF v_kind = 'swap' THEN
      v_swap_kind := v_move->>'swapKind';
      v_candidate_roster_id := (v_move->>'designateRosterPlayerId')::uuid;
      v_candidate_player_id := (v_move->>'designatePlayerId')::uuid;
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      IF v_swap_kind = 'incumbent' THEN
        BEGIN
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today)
            INTO v_candidate_status, v_candidate_return
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_candidate_roster_id
           FOR SHARE OF p;
          SELECT p.injury_status, private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
            INTO v_occupant_status, v_occupant_return, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          v_planned_contender_return := (v_move->>'plannedContenderReturn')::date;
          v_planned_incumbent_return := (v_move->>'plannedIncumbentReturn')::date;
          IF NOT private.is_ir_designation(v_candidate_status)
             OR v_candidate_return IS NULL
             OR v_planned_contender_return IS NULL
             OR v_candidate_return <> v_planned_contender_return
             OR NOT v_occupant_on_ir
             OR NOT private.is_ir_designation(v_occupant_status)
             OR v_occupant_return IS NULL
             OR v_planned_incumbent_return IS NULL
             OR v_occupant_return <> v_planned_incumbent_return
             OR v_planned_contender_return <= v_planned_incumbent_return THEN
            RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
          END IF;
          FOR v_compared_player_id IN
            SELECT (value)::uuid
              FROM jsonb_array_elements_text(COALESCE(v_move->'comparedIncumbentPlayerIds', '[]'::jsonb))
             ORDER BY 1
          LOOP
            SELECT private.ir_reliable_return(p.injury_expected_return, v_today), rp.is_on_ir
              INTO v_compared_return, v_compared_on_ir
              FROM roster_players rp
              JOIN players p ON p.id = rp.player_id
             WHERE rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id
               AND rp.member_id = p_member_id
               AND rp.player_id = v_compared_player_id
             FOR SHARE OF p;
            IF v_compared_on_ir AND v_compared_return IS NOT NULL AND v_compared_return <= v_planned_incumbent_return THEN
              RAISE EXCEPTION 'Incumbent exchange no longer valid.' USING ERRCODE = 'P0001';
            END IF;
          END LOOP;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      ELSE
        BEGIN
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_candidate_player_id);
          PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
          SELECT p.injury_status, rp.is_on_ir
            INTO v_occupant_status, v_occupant_on_ir
            FROM roster_players rp
            JOIN players p ON p.id = rp.player_id
           WHERE rp.id = v_occupant_roster_id
           FOR SHARE OF p;
          IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
            RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
          END IF;
          PERFORM private.toggle_ir_for_activation(v_candidate_roster_id, true, v_user_id, v_occupant_roster_id);
          PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
          PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
          v_moves := v_moves || jsonb_build_object(
            'kind', 'swap',
            'designatePlayerId', v_candidate_player_id,
            'activatePlayerId', v_occupant_player_id
          );
        EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
          v_skipped := v_skipped || jsonb_build_object('playerId', v_candidate_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
        END;
      END IF;
    ELSIF v_kind = 'activate' THEN
      v_occupant_roster_id := (v_move->>'activateRosterPlayerId')::uuid;
      v_occupant_player_id := (v_move->>'activatePlayerId')::uuid;
      BEGIN
        PERFORM private.assert_asset_unlocked(p_league_id, p_league_season_id, p_member_id, v_occupant_player_id);
        SELECT p.injury_status, rp.is_on_ir
          INTO v_occupant_status, v_occupant_on_ir
          FROM roster_players rp
          JOIN players p ON p.id = rp.player_id
         WHERE rp.id = v_occupant_roster_id
         FOR SHARE OF p;
        IF NOT v_occupant_on_ir OR private.is_ir_designation(v_occupant_status) THEN
          RAISE EXCEPTION 'Healthy occupant is no longer activatable.' USING ERRCODE = 'P0001';
        END IF;
        PERFORM private.toggle_ir_for_activation(v_occupant_roster_id, false, v_user_id, NULL);
        PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, p_member_id);
        v_moves := v_moves || jsonb_build_object('kind', 'activate', 'activatePlayerId', v_occupant_player_id);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IN ('55P03', '40001', '40P01', '57014') THEN v_transient := SQLSTATE; END IF;
        v_skipped := v_skipped || jsonb_build_object('playerId', v_occupant_player_id, 'reason', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    END IF;
  END LOOP;

  IF v_transient IS NOT NULL AND v_league_auto_ir THEN
    RAISE EXCEPTION 'Auto IR move failed transiently (%)', v_transient USING ERRCODE = v_transient;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.id), '[]'::jsonb)
    INTO v_taxi_after
    FROM roster_players rp
   WHERE rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.is_on_taxi;
  IF v_taxi_after IS DISTINCT FROM v_taxi_before THEN
    RAISE EXCEPTION 'Auto IR management changed taxi rows.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_ids_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;
  IF v_ids_after IS DISTINCT FROM v_ids_before THEN
    RAISE EXCEPTION 'Auto IR management changed the roster membership.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(kind || ':' || COALESCE(roster_player_id::text, '') ORDER BY kind, roster_player_id), ARRAY[]::text[])
    INTO v_problems_after
    FROM private.roster_problems(p_league_id, p_league_season_id, p_member_id);
  IF EXISTS (SELECT 1 FROM unnest(v_problems_after) AS p WHERE p <> ALL(v_problems_before)) THEN
    RAISE EXCEPTION 'Auto IR management introduced a new roster problem.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) FILTER (WHERE is_on_ir),
         count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi)
    INTO v_ir_after, v_active_after
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id;

  IF v_ir_after > v_ir_slots
     AND NOT (v_ir_before > v_ir_slots AND v_ir_after <= v_ir_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the IR capacity.' USING ERRCODE = 'P0001';
  END IF;
  IF v_active_after > v_roster_size
     AND NOT (v_active_before > v_roster_size AND v_active_after <= v_active_before) THEN
    RAISE EXCEPTION 'Auto IR management exceeded the active roster capacity.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('moves', v_moves, 'skipped', v_skipped, 'notices', v_notices);
END;
$function$;


CREATE OR REPLACE FUNCTION private.run_league_roster_floor(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_season public.league_seasons%ROWTYPE;
  v_floor int;
  v_target int;
  v_week_number int;
  v_week_end date;
  v_latest_week_number int;
  v_latest_week_end date;
  v_pending_week_number int;
  v_pending_week_end date;
  v_zone text;
  v_ready jsonb;
  v_watermark text;
  v_week_row private.roster_floor_weeks%ROWTYPE;
  v_member record;
  v_team uuid;
  v_active int;
  v_player record;
  v_awarded int := 0;
  v_pass_awarded int;
  v_short boolean;
  v_teams jsonb;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_invocation text := nullif(nullif(current_setting('request.headers', true), '')::jsonb->>'x-pancake-work-key', '');
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'league');
  END IF;
  IF v_league.status NOT IN ('active'::public.league_status, 'playoffs'::public.league_status) THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'league_status');
  END IF;
  SELECT * INTO v_season
    FROM public.league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'season');
  END IF;
  SELECT policy.weekly_roster_floor
    INTO v_floor
    FROM private.league_roster_policies policy
   WHERE policy.league_id = p_league_id;
  IF v_floor IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'disabled');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.floor_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'worker_pending');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.league_roster_policies policy
     WHERE policy.league_id = p_league_id
       AND policy.ir_activated_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'ir_pending');
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_league_season_id::text)) THEN
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'busy');
  END IF;

  v_zone := COALESCE(v_league.timezone, 'America/Los_Angeles');

  SELECT weeks.week_number, weeks.week_end
    INTO v_latest_week_number, v_latest_week_end
    FROM public.season_weeks weeks
   WHERE weeks.season_year = v_season.season_year
     AND weeks.week_end <= v_today
     AND EXISTS (
       SELECT 1
         FROM public.matchups matchup
        WHERE matchup.league_id = p_league_id
          AND matchup.league_season_id = p_league_season_id
          AND matchup.week_number = weeks.week_number
     )
   ORDER BY weeks.week_end DESC, weeks.week_number DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_week');
  END IF;

  SELECT week_row.week_number, week_row.week_end
    INTO v_pending_week_number, v_pending_week_end
    FROM private.roster_floor_weeks week_row
   WHERE week_row.league_id = p_league_id
     AND week_row.league_season_id = p_league_season_id
     AND week_row.status = 'pending'
     AND week_row.week_end <= v_today
     AND EXISTS (
       SELECT 1
         FROM public.matchups matchup
        WHERE matchup.league_id = p_league_id
          AND matchup.league_season_id = p_league_season_id
          AND matchup.week_number = week_row.week_number
     )
   ORDER BY week_row.week_end, week_row.week_number
   LIMIT 1;

  IF FOUND AND v_pending_week_end < v_latest_week_end
     AND (v_latest_week_end + time '00:00') AT TIME ZONE v_zone <= now() THEN
    UPDATE private.roster_floor_weeks week_row
       SET status = 'expired', expired_at = now()
     WHERE week_row.league_id = p_league_id
       AND week_row.league_season_id = p_league_season_id
       AND week_row.status = 'pending'
       AND week_row.week_end < v_latest_week_end;
    v_week_number := v_latest_week_number;
    v_week_end := v_latest_week_end;
  ELSIF FOUND THEN
    v_week_number := v_pending_week_number;
    v_week_end := v_pending_week_end;
  ELSE
    v_week_number := v_latest_week_number;
    v_week_end := v_latest_week_end;
  END IF;

  v_target := LEAST(v_floor, COALESCE(v_league.roster_size, 20));

  INSERT INTO private.roster_floor_weeks(league_id, league_season_id, week_number, week_end, team_order, status)
  SELECT p_league_id, p_league_season_id, v_week_number, v_week_end,
    COALESCE(array_agg(member.id ORDER BY random()), ARRAY[]::uuid[]), 'pending'
    FROM public.league_members member
   WHERE member.league_id = p_league_id
  ON CONFLICT (league_id, league_season_id, week_number) DO NOTHING;

  SELECT * INTO v_week_row
    FROM private.roster_floor_weeks week_row
   WHERE week_row.league_id = p_league_id
     AND week_row.league_season_id = p_league_season_id
     AND week_row.week_number = v_week_number
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_week');
  END IF;
  IF v_week_row.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'completed', 'weekNumber', v_week_number,
      'weekEnd', v_week_end, 'awarded', 0);
  END IF;
  IF v_week_row.status = 'expired' THEN
    RETURN jsonb_build_object('status', 'expired', 'weekNumber', v_week_number,
      'weekEnd', v_week_end, 'awarded', 0);
  END IF;

  v_ready := private.roster_floor_week_ready(p_league_id, p_league_season_id, v_week_number, v_week_end);
  IF NOT COALESCE((v_ready->>'ready')::boolean, false) THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = v_ready->>'reason', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', v_ready->>'reason',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END IF;

  IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id) THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'averages_pending', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'averages_pending',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END IF;
  v_watermark := private.roster_floor_averages_watermark(p_league_id, p_league_season_id);

  BEGIN
    IF v_invocation IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM private.work_items item
       WHERE item.invocation_key = v_invocation::uuid
         AND item.status = 'running'
         AND item.lease_until > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE = 'PT409';
    END IF;
    FOR v_member IN
      SELECT member.id
        FROM public.league_members member
       WHERE member.league_id = p_league_id
       ORDER BY member.id
    LOOP
      PERFORM public.auto_manage_ir_service(p_league_id, p_league_season_id, v_member.id);
    END LOOP;

    LOOP
      v_pass_awarded := 0;
      v_short := false;
      FOR v_team IN SELECT unnest(v_week_row.team_order) AS member_id LOOP
        SELECT count(*)
          INTO v_active
          FROM public.roster_players roster
         WHERE roster.league_id = p_league_id
           AND roster.league_season_id = p_league_season_id
           AND roster.member_id = v_team
           AND NOT roster.is_on_ir
           AND NOT roster.is_on_taxi;
        IF v_active >= v_target THEN
          CONTINUE;
        END IF;
        v_short := true;
        PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_team::text));
        SELECT count(*)
          INTO v_active
          FROM public.roster_players roster
         WHERE roster.league_id = p_league_id
           AND roster.league_season_id = p_league_season_id
           AND roster.member_id = v_team
           AND NOT roster.is_on_ir
           AND NOT roster.is_on_taxi;
        IF v_active >= v_target THEN
          CONTINUE;
        END IF;
        FOR v_player IN
          SELECT pool.player_id, pool.avg_fantasy_points
            FROM private.roster_floor_pool(p_league_id, p_league_season_id) pool
           WHERE NOT EXISTS (
             SELECT 1
               FROM private.roster_floor_awards award
              WHERE award.league_id = p_league_id
                AND award.league_season_id = p_league_season_id
                AND award.week_number = v_week_number
                AND award.player_id = pool.player_id
           )
           ORDER BY pool.avg_fantasy_points DESC, pool.player_id
        LOOP
          PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_player.player_id::text));
          IF NOT private.roster_floor_player_legal(p_league_id, p_league_season_id, v_player.player_id) THEN
            CONTINUE;
          END IF;
          IF EXISTS (
            SELECT 1
              FROM public.nba_games game
             WHERE game.game_date IN (v_today - 1, v_today)
               AND game.status IN ('Scheduled', 'InProgress')
               AND private.lineup_game_available(game.status, game.game_status_text)
               AND (
                 game.status = 'InProgress'
                 OR game.game_time <= clock_timestamp()
                 OR game.started_at <= clock_timestamp()
               )
          ) THEN
            RAISE EXCEPTION 'Roster floor deferred: a game is in progress' USING ERRCODE = 'PF001';
          END IF;
          BEGIN
            INSERT INTO public.roster_players(
              league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi
            )
            VALUES (
              p_league_id, p_league_season_id, v_team, v_player.player_id, 'roster_floor', false, false
            );
            PERFORM private.assert_accepted_trade_capacity(p_league_id, p_league_season_id, v_team);
            INSERT INTO public.roster_transactions(
              league_id, league_season_id, member_id, player_id, transaction_type
            )
            VALUES (
              p_league_id, p_league_season_id, v_team, v_player.player_id, 'fa_add'
            );
            INSERT INTO private.roster_floor_awards(
              league_id, league_season_id, week_number, member_id, player_id
            )
            VALUES (
              p_league_id, p_league_season_id, v_week_number, v_team, v_player.player_id
            );
            IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id)
               OR private.roster_floor_averages_watermark(p_league_id, p_league_season_id) IS DISTINCT FROM v_watermark THEN
              RAISE EXCEPTION 'Roster floor averages changed during the pass' USING ERRCODE = 'PF002';
            END IF;
            v_awarded := v_awarded + 1;
            v_pass_awarded := v_pass_awarded + 1;
            EXIT;
          EXCEPTION WHEN SQLSTATE 'PT409' THEN
            IF v_invocation IS NOT NULL AND NOT EXISTS (
              SELECT 1
                FROM private.work_items item
               WHERE item.invocation_key = v_invocation::uuid
                 AND item.status = 'running'
                 AND item.lease_until > clock_timestamp()
            ) THEN
              RAISE;
            END IF;
          END;
        END LOOP;
      END LOOP;
      EXIT WHEN NOT v_short OR v_pass_awarded = 0;
    END LOOP;

    IF NOT private.roster_floor_averages_ready(p_league_id, p_league_season_id)
       OR private.roster_floor_averages_watermark(p_league_id, p_league_season_id) IS DISTINCT FROM v_watermark THEN
      RAISE EXCEPTION 'Roster floor averages changed during the pass' USING ERRCODE = 'PF002';
    END IF;
    IF v_invocation IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM private.work_items item
       WHERE item.invocation_key = v_invocation::uuid
         AND item.status = 'running'
         AND item.lease_until > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE = 'PT409';
    END IF;
    UPDATE private.roster_floor_weeks
       SET status = 'completed', completed_at = now(), last_deferral_reason = NULL, last_deferred_at = NULL
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
  EXCEPTION WHEN SQLSTATE 'PF001' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'game_in_progress', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'game_in_progress',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  WHEN SQLSTATE 'PF002' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'averages_pending', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'averages_pending',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  WHEN SQLSTATE '55P03' OR SQLSTATE '40001' OR SQLSTATE '40P01' OR SQLSTATE '57014' THEN
    UPDATE private.roster_floor_weeks
       SET last_deferral_reason = 'ir_transient', last_deferred_at = now()
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND week_number = v_week_number;
    RETURN jsonb_build_object('status', 'deferred', 'reason', 'ir_transient',
      'weekNumber', v_week_number, 'weekEnd', v_week_end);
  END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', member.id, 'active', counts.active) ORDER BY member.id), '[]'::jsonb)
    INTO v_teams
    FROM public.league_members member
    CROSS JOIN LATERAL (
      SELECT count(*) AS active
        FROM public.roster_players roster
       WHERE roster.league_id = p_league_id
         AND roster.league_season_id = p_league_season_id
         AND roster.member_id = member.id
         AND NOT roster.is_on_ir
         AND NOT roster.is_on_taxi
    ) counts
   WHERE member.league_id = p_league_id;

  RETURN jsonb_build_object('status', 'completed', 'weekNumber', v_week_number,
    'weekEnd', v_week_end, 'floor', v_floor, 'target', v_target,
    'awarded', v_awarded, 'teams', v_teams);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_roster_floor_service(
  p_league_id uuid DEFAULT NULL,
  p_league_season_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_league record;
  v_result jsonb;
BEGIN
  IF p_league_id IS NOT NULL THEN
    RETURN private.run_league_roster_floor(p_league_id, p_league_season_id);
  END IF;
  FOR v_league IN
    SELECT policy.league_id, season.id AS season_id
      FROM private.league_roster_policies policy
      JOIN public.leagues league
        ON league.id = policy.league_id
       AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status)
      JOIN public.league_seasons season
        ON season.league_id = league.id
       AND season.is_current
     WHERE policy.weekly_roster_floor IS NOT NULL
     ORDER BY policy.league_id
  LOOP
    BEGIN
      v_result := private.run_league_roster_floor(v_league.league_id, v_league.season_id);
    EXCEPTION WHEN OTHERS THEN
      v_result := jsonb_build_object('status', 'failed', 'reason', SQLERRM);
    END;
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;
  RETURN jsonb_build_object('leagues', v_results);
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_trade record; v_waiver record; v_floor record; v_waiver_day date; v_waiver_due timestamptz;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  IF EXISTS (
    SELECT 1
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < 3
           AND COALESCE(job.completed_at, job.created_at) <= (p_now + interval '1 minute') - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
           job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= (p_now + interval '1 minute') - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= (p_now + interval '1 minute') - interval '120 seconds'
               )
             )
           )
         )
       )
  ) THEN
    PERFORM private.work_enqueue(
      'stats-sync',date_trunc('minute',p_now)::text,p_now,
      '{"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"}'::jsonb
    );
  END IF;
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= p_now
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= p_now
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= p_now
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= p_now
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= p_now - interval '60 seconds')
  ) THEN
    PERFORM private.work_enqueue('process-trades',date_trunc('minute',p_now)::text,p_now);
  END IF;
  PERFORM private.enqueue_lineup_optimizer(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    IF ((p_now AT TIME ZONE 'America/New_York')::time>=time '04:00' AND (p_now AT TIME ZONE 'America/New_York')::time<time '06:00') THEN
      PERFORM private.enqueue_daily('sync-players',4,0,p_now);
      PERFORM private.enqueue_daily('sync-trade-values',4,0,p_now);
      PERFORM private.enqueue_rankings(p_now);
      FOR v_trade IN SELECT DISTINCT queued.league_id,queued.league_season_id,queued.version
        FROM private.screen_refresh_queue queued JOIN public.trades trade ON trade.league_season_id=queued.league_season_id
        WHERE trade.status IN ('pending','accepted') LOOP
        PERFORM private.work_enqueue('trade-revaluation-scan',v_trade.league_season_id::text||':'||
          (p_now AT TIME ZONE 'America/New_York')::date::text,p_now,
          jsonb_build_object('revaluationScan',true,'leagueId',v_trade.league_id,'seasonId',v_trade.league_season_id,
            'version',v_trade.version),v_trade.league_id);
      END LOOP;
    END IF;
    PERFORM private.enqueue_daily('missing-final-stats',6,30,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    FOR v_waiver IN SELECT DISTINCT coalesce(timezone, 'America/Los_Angeles') AS timezone
      FROM public.leagues WHERE status IN ('active', 'playoffs', 'offseason') LOOP
      v_waiver_day := (p_now AT TIME ZONE v_waiver.timezone)::date;
      v_waiver_due := v_waiver_day::timestamp AT TIME ZONE v_waiver.timezone;
      PERFORM private.work_enqueue('process-waivers', v_waiver.timezone || ':' || v_waiver_day::text, v_waiver_due, jsonb_build_object('timezone', v_waiver.timezone, 'date', v_waiver_day));
    END LOOP;
    FOR v_floor IN
      SELECT policy.league_id, season.id AS season_id, weeks.week_end
        FROM private.league_roster_policies policy
        JOIN public.leagues league ON league.id = policy.league_id
          AND league.status IN ('active', 'playoffs')
        JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
        JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
          AND weeks.week_end <= (p_now AT TIME ZONE 'America/New_York')::date
       WHERE policy.weekly_roster_floor IS NOT NULL
         AND policy.floor_activated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.matchups matchup
            WHERE matchup.league_id = league.id
              AND matchup.league_season_id = season.id
              AND matchup.week_number = weeks.week_number
         )
         AND (weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles') <= p_now
         AND NOT EXISTS (
           SELECT 1 FROM private.roster_floor_weeks week_row
            WHERE week_row.league_id = policy.league_id
              AND week_row.league_season_id = season.id
              AND week_row.week_number = weeks.week_number
              AND week_row.status IN ('completed', 'expired')
         )
         AND (
           weeks.week_end = (
             SELECT max(latest.week_end)
               FROM public.season_weeks latest
              WHERE latest.season_year = season.season_year
                AND latest.week_end <= (p_now AT TIME ZONE 'America/New_York')::date
                AND EXISTS (
                  SELECT 1 FROM public.matchups matchup
                   WHERE matchup.league_id = league.id
                     AND matchup.league_season_id = season.id
                     AND matchup.week_number = latest.week_number
                )
           )
           OR EXISTS (
             SELECT 1 FROM private.roster_floor_weeks pending
              WHERE pending.league_id = policy.league_id
                AND pending.league_season_id = season.id
                AND pending.week_number = weeks.week_number
                AND pending.status = 'pending'
           )
         )
    LOOP
      PERFORM private.work_enqueue(
        'roster-floor',
        v_floor.league_id::text || ':' || v_floor.week_end::text || ':' || (extract(epoch FROM p_now) / 900)::bigint::text,
        p_now,
        jsonb_build_object('leagueId', v_floor.league_id, 'leagueSeasonId', v_floor.season_id,
          'weekEnd', v_floor.week_end, 'bucket', (extract(epoch FROM p_now) / 900)::bigint),
        v_floor.league_id
      );
    END LOOP;
    PERFORM private.enqueue_season_boundary(p_now);
    PERFORM private.enqueue_projection_sync(p_now);
    IF (p_now AT TIME ZONE 'America/New_York')::time>=time '06:20' AND EXISTS(
      SELECT 1 FROM public.nba_games WHERE game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-7
      AND (p_now AT TIME ZONE 'America/New_York')::date-1 AND nba_game_id LIKE '002%' AND status='Final'
    ) THEN
      PERFORM private.work_enqueue('daily-stat-corrections',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
    END IF;
  END IF;
  IF v_min%15=5 THEN PERFORM private.enqueue_daily('sync-schedule',6,5,p_now); END IF;
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
  IF v_min>=17 THEN
    PERFORM private.work_enqueue('public-read-retention',date_trunc('hour',p_now)::text,p_now);
  END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF v_utc::time>=time '10:00' THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_work()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_count integer:=0;
  v_started timestamptz:=clock_timestamp(); v_level text; v_kinds text[]; v_waiver record; v_floor record; v_day date;
BEGIN
  IF (SELECT paused FROM private.worker_controls WHERE id) THEN RETURN 0; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.dispatch_work',0)) THEN RETURN 0; END IF;
  BEGIN
    PERFORM private.flush_player_stats_hints();
    PERFORM private.flush_league_inventory_hints(1000);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Hint publication will retry: %',SQLERRM;
  END;
  PERFORM private.release_stalled_live_poll();
  v_count:=private.dispatch_live_matchup_refresh();
  v_level:=private.apply_scheduler_health(private.scheduler_health());
  IF clock_timestamp()-v_started>=interval '2 seconds' THEN RETURN v_count; END IF;
  IF v_level='normal' THEN
    PERFORM private.enqueue_scheduled_work(now());
  ELSE
    IF v_level='paused' THEN
      UPDATE private.worker_controls SET scheduler_last_dispatch_at=clock_timestamp()
      WHERE id AND (scheduler_last_dispatch_at IS NULL OR scheduler_last_dispatch_at<=clock_timestamp()-interval '5 minutes');
      IF NOT FOUND THEN RETURN v_count; END IF;
      v_kinds:=ARRAY['process-waivers','process-trades','live-poll','refresh-live-matchups','roster-floor'];
    ELSE
      v_kinds:=ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile','refresh-live-matchups','roster-floor'];
      PERFORM private.enqueue_stats_sync_dispatch(now());
      IF extract(minute FROM now())::int%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
        WHERE reconciled_at IS NULL OR worker_status='running') THEN
        PERFORM private.work_enqueue('edge-invocation-reconcile',date_trunc('minute',now())::text,now());
      END IF;
    END IF;
    PERFORM private.enqueue_process_trades(now());
    IF v_level='paused' OR extract(minute FROM now())::int%2=0 THEN PERFORM private.enqueue_live_poll(now()); END IF;
    IF v_level='paused' OR extract(minute FROM now())::int%15=0 THEN
      FOR v_waiver IN SELECT DISTINCT coalesce(timezone,'America/Los_Angeles') AS timezone
        FROM public.leagues WHERE status IN ('active','playoffs','offseason') LOOP
        v_day:=(now() AT TIME ZONE v_waiver.timezone)::date;
        PERFORM private.work_enqueue('process-waivers',v_waiver.timezone||':'||v_day::text,
          v_day::timestamp AT TIME ZONE v_waiver.timezone,jsonb_build_object('timezone',v_waiver.timezone,'date',v_day));
      END LOOP;
    END IF;
    FOR v_floor IN
      SELECT policy.league_id, season.id AS season_id, weeks.week_end
        FROM private.league_roster_policies policy
        JOIN public.leagues league ON league.id = policy.league_id
          AND league.status IN ('active', 'playoffs')
        JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
        JOIN public.season_weeks weeks ON weeks.season_year = season.season_year
          AND weeks.week_end <= (now() AT TIME ZONE 'America/New_York')::date
       WHERE policy.weekly_roster_floor IS NOT NULL
         AND policy.floor_activated_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.matchups matchup
            WHERE matchup.league_id = league.id
              AND matchup.league_season_id = season.id
              AND matchup.week_number = weeks.week_number
         )
         AND (weeks.week_end + time '00:00') AT TIME ZONE COALESCE(league.timezone, 'America/Los_Angeles') <= now()
         AND NOT EXISTS (
           SELECT 1 FROM private.roster_floor_weeks week_row
            WHERE week_row.league_id = policy.league_id
              AND week_row.league_season_id = season.id
              AND week_row.week_number = weeks.week_number
              AND week_row.status IN ('completed', 'expired')
         )
         AND (
           weeks.week_end = (
             SELECT max(latest.week_end)
               FROM public.season_weeks latest
              WHERE latest.season_year = season.season_year
                AND latest.week_end <= (now() AT TIME ZONE 'America/New_York')::date
                AND EXISTS (
                  SELECT 1 FROM public.matchups matchup
                   WHERE matchup.league_id = league.id
                     AND matchup.league_season_id = season.id
                     AND matchup.week_number = latest.week_number
                )
           )
           OR EXISTS (
             SELECT 1 FROM private.roster_floor_weeks pending
              WHERE pending.league_id = policy.league_id
                AND pending.league_season_id = season.id
                AND pending.week_number = weeks.week_number
                AND pending.status = 'pending'
           )
         )
    LOOP
      PERFORM private.work_enqueue(
        'roster-floor',
        v_floor.league_id::text || ':' || v_floor.week_end::text || ':' || (extract(epoch FROM now()) / 900)::bigint::text,
        now(),
        jsonb_build_object('leagueId', v_floor.league_id, 'leagueSeasonId', v_floor.season_id,
          'weekEnd', v_floor.week_end, 'bucket', (extract(epoch FROM now()) / 900)::bigint),
        v_floor.league_id
      );
    END LOOP;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.work_items
    WHERE status IN ('pending','failed') AND due_at<=now()
      OR status='running' AND lease_until<=now()) THEN RETURN v_count; END IF;
  LOOP
    EXIT WHEN v_count>=32 OR clock_timestamp()-v_started>=interval '2 seconds';
    IF v_level='normal' THEN
      SELECT * INTO v_item FROM private.work_claim(1);
    ELSE
      PERFORM private.work_claim(0);
      WITH due AS (
        SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
          AND kind=ANY(v_kinds)
          AND (SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp())<4
        ORDER BY CASE WHEN kind='live-poll' THEN 0 ELSE 1 END,due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE private.work_items item SET status='running',attempts=attempts+1,
        lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
      FROM due WHERE item.id=due.id RETURNING item.* INTO v_item;
    END IF;
    EXIT WHEN NOT FOUND;
    BEGIN
      PERFORM private.work_execute(v_item.id,v_item.lease_token);
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.work_finish(v_item.id,v_item.lease_token,SQLERRM);
    END;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.roster_floor_week_ready(uuid, uuid, int, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.roster_floor_pool(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.run_league_roster_floor(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.process_roster_floor_service(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_roster_floor_service(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION private.roster_floor_player_legal(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.pre_tipoff_input_fingerprint(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.roster_status_game_started_live(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.settle_waiver_runs(text, date, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.settle_waiver_runs(text, date, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_waiver_runs(text, date, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.settle_latest_waiver_runs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_latest_waiver_runs(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION private.roster_floor_averages_ready(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM private.screen_refresh_queue queued
      JOIN public.leagues league ON league.id = queued.league_id
     WHERE queued.league_id = p_league_id
       AND queued.league_season_id = p_league_season_id
       AND queued.averages_initialized
       AND queued.averages_scoring IS NOT DISTINCT FROM league.scoring_settings
  ) AND NOT EXISTS (
    SELECT 1
      FROM private.screen_average_dirty dirty
     WHERE dirty.league_season_id = p_league_season_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.roster_floor_averages_watermark(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::text || ':' || COALESCE(max(cached.refreshed_at)::text, '') || ':' || COALESCE(max(cached.version)::text, '')
    FROM public.player_season_averages cached
   WHERE cached.league_id = p_league_id
     AND cached.league_season_id = p_league_season_id
$$;
