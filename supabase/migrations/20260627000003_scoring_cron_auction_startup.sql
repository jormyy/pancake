-- Scoring, cron, and auction startup hardening:
-- - Round SQL fantasy scoring to match TS implementations.
-- - Keep game_time populated for scheduled game locks.
-- - Run daily cron jobs in UTC windows guarded by America/New_York wall clock.
-- - Make auction startup atomic/deterministic.
-- - Prevent auction close from overfilling active rosters.
-- - Make rookie draft tied ordering deterministic.

CREATE OR REPLACE FUNCTION compute_fantasy_points(
  p_stat_id   uuid,
  p_league_id uuid
)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_settings jsonb;
  v_stats    player_game_stats%ROWTYPE;
  v_total    numeric := 0;
BEGIN
  SELECT scoring_settings INTO v_settings
    FROM leagues WHERE id = p_league_id;

  SELECT pgs.* INTO v_stats
    FROM player_game_stats pgs
    INNER JOIN nba_games g ON g.id = pgs.game_id
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

CREATE OR REPLACE VIEW v_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  pgs.id           AS stat_id,
  l.id             AS league_id,
  pgs.player_id,
  pgs.game_id,
  pgs.season_year,
  pgs.week_number,
  CASE WHEN pgs.did_not_play THEN 0::numeric ELSE ROUND((
    COALESCE(pgs.points                * (l.scoring_settings->>'points')::numeric,                0) +
    COALESCE(pgs.rebounds              * (l.scoring_settings->>'rebounds')::numeric,              0) +
    COALESCE(pgs.assists               * (l.scoring_settings->>'assists')::numeric,               0) +
    COALESCE(pgs.steals                * (l.scoring_settings->>'steals')::numeric,                0) +
    COALESCE(pgs.blocks                * (l.scoring_settings->>'blocks')::numeric,                0) +
    COALESCE(pgs.turnovers             * (l.scoring_settings->>'turnovers')::numeric,             0) +
    COALESCE(pgs.three_pointers_made   * (l.scoring_settings->>'three_pointers_made')::numeric,   0) +
    COALESCE(pgs.field_goals_made      * (l.scoring_settings->>'field_goals_made')::numeric,      0) +
    COALESCE(pgs.field_goals_attempted * (l.scoring_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(pgs.free_throws_made      * (l.scoring_settings->>'free_throws_made')::numeric,      0) +
    COALESCE(pgs.free_throws_attempted * (l.scoring_settings->>'free_throws_attempted')::numeric, 0) +
    CASE WHEN pgs.double_double = true
      THEN COALESCE((l.scoring_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN pgs.triple_double = true
      THEN COALESCE((l.scoring_settings->>'triple_double')::numeric, 0) ELSE 0 END
  ), 2) END AS fantasy_points
FROM player_game_stats pgs
INNER JOIN nba_games g
  ON g.id = pgs.game_id
  AND public.is_regular_season_game_id(g.nba_game_id)
CROSS JOIN leagues l;

GRANT SELECT ON v_fantasy_points TO authenticated;

UPDATE public.nba_games
   SET game_time = COALESCE(game_time, started_at)
 WHERE game_time IS NULL
   AND started_at IS NOT NULL
   AND public.is_regular_season_game_id(nba_game_id);

CREATE OR REPLACE FUNCTION public.invoke_edge_function_at_et_time(
  p_function_name text,
  p_hour int,
  p_minute int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp;
BEGIN
  v_now := timezone('America/New_York', now());
  IF EXTRACT(HOUR FROM v_now)::int = p_hour
     AND EXTRACT(MINUTE FROM v_now)::int = p_minute THEN
    PERFORM public.invoke_edge_function(p_function_name);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, int, int) FROM PUBLIC;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-sync-schedule') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-sync-schedule'
    );
    PERFORM cron.unschedule('nba-sync-players') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-sync-players'
    );
    PERFORM cron.unschedule('nba-sync-projections') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-sync-projections'
    );
    PERFORM cron.unschedule('nba-sync-rankings') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-sync-rankings'
    );
    PERFORM cron.unschedule('nba-process-waivers') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-process-waivers'
    );

    PERFORM cron.schedule('nba-sync-players', '0 10,11 * * *',
      $$SELECT public.invoke_edge_function_at_et_time('sync-players', 6, 0)$$);
    PERFORM cron.schedule('nba-sync-schedule', '5 10,11 * * *',
      $$SELECT public.invoke_edge_function_at_et_time('sync-schedule', 6, 5)$$);
    PERFORM cron.schedule('nba-sync-projections', '0 12,13 * * *',
      $$SELECT public.invoke_edge_function_at_et_time('sync-projections', 8, 0)$$);
    PERFORM cron.schedule('nba-sync-rankings', '0 11,12 * * 1',
      $$SELECT public.invoke_edge_function_at_et_time('sync-rankings', 7, 0)$$);
    PERFORM cron.schedule('nba-process-waivers', '0 7,8 * * *',
      $$SELECT public.invoke_edge_function_at_et_time('process-waivers', 3, 0)$$);
  END IF;
END
$cron$;

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated'
)
RETURNS drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
       AND status IN ('pending', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'A draft already exists for this league season';
  END IF;

  SELECT count(*) INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;
  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    started_at,
    current_nomination_order,
    nomination_order_mode
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_league.auction_budget,
    now(),
    1,
    p_nomination_order_mode
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_league.auction_budget, v_league.auction_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = p_league_id;

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_auction_draft_atomic(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.close_auction_nomination_atomic(
  p_nomination_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nom nominations%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_budget draft_budgets%ROWTYPE;
  v_roster_size int;
  v_active_roster_count int;
BEGIN
  SELECT *
    INTO v_nom
    FROM nominations
   WHERE id = p_nomination_id
     AND status = 'open'
     AND countdown_expires_at < now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = v_nom.draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_nom.current_bidder_id IS NOT NULL THEN
    SELECT *
      INTO v_budget
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND member_id = v_nom.current_bidder_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Winning bidder budget not found';
    END IF;

    IF v_budget.remaining < v_nom.current_bid_amount THEN
      RAISE EXCEPTION 'Winning bidder no longer has enough remaining budget';
    END IF;

    SELECT roster_size
      INTO v_roster_size
      FROM leagues
     WHERE id = v_draft.league_id
     FOR UPDATE;

    PERFORM 1
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = v_nom.current_bidder_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false
     FOR UPDATE;

    SELECT count(*)
      INTO v_active_roster_count
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND member_id = v_nom.current_bidder_id
       AND COALESCE(is_on_ir, false) = false
       AND COALESCE(is_on_taxi, false) = false;

    IF v_active_roster_count >= v_roster_size THEN
      RAISE EXCEPTION 'Winning bidder roster is full';
    END IF;

    UPDATE draft_budgets
       SET remaining = remaining - v_nom.current_bid_amount
     WHERE id = v_budget.id;

    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      acquired_via,
      acquisition_cost
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      v_nom.current_bidder_id,
      v_nom.player_id,
      'draft',
      v_nom.current_bid_amount
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      related_nomination_id
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      v_nom.current_bidder_id,
      v_nom.player_id,
      'draft_won',
      v_nom.id
    );

    UPDATE nominations
       SET status = 'sold',
           winning_member_id = v_nom.current_bidder_id,
           final_price = v_nom.current_bid_amount,
           closed_at = now()
     WHERE id = v_nom.id;
  ELSE
    UPDATE nominations
       SET status = 'no_bid',
           closed_at = now()
     WHERE id = v_nom.id;
  END IF;

  UPDATE drafts
     SET current_nomination_order = current_nomination_order + 1
   WHERE id = v_nom.draft_id;

  IF NOT EXISTS (
    SELECT 1
      FROM draft_budgets
     WHERE draft_id = v_nom.draft_id
       AND remaining >= 1
  ) THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = now()
     WHERE id = v_nom.draft_id;

    UPDATE leagues
       SET status = 'active'
     WHERE id = v_draft.league_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.close_auction_nomination_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.close_auction_nomination_atomic(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_last_season_id uuid;
  v_pick_count int;
BEGIN
  IF p_rounds < 1 THEN
    RAISE EXCEPTION 'Rookie draft must have at least one round.';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status <> 'offseason' THEN
    RAISE EXCEPTION 'League must be in offseason to start rookie draft';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  PERFORM 1
    FROM drafts
   WHERE league_id = p_league_id
     AND league_season_id = v_season.id
     AND draft_type = 'snake'
     AND status IN ('pending', 'in_progress')
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'A rookie draft already exists for this season';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  SELECT id
    INTO v_last_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = false
   ORDER BY season_year DESC
   LIMIT 1;

  CREATE TEMP TABLE pg_temp.rookie_draft_order (
    member_id uuid PRIMARY KEY,
    position int NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.rookie_draft_order (member_id, position)
  SELECT member_id, row_number() OVER (
    ORDER BY
      has_standings DESC,
      wins ASC,
      points_for ASC,
      member_id ASC
  )::int
  FROM (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      COALESCE(latest.wins, 0) AS wins,
      COALESCE(latest.points_for, 0) AS points_for
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.points_for
        FROM standings AS s
       WHERE v_last_season_id IS NOT NULL
         AND s.league_id = p_league_id
         AND s.league_season_id = v_last_season_id
         AND s.member_id = lm.id
       ORDER BY s.week_number DESC
       LIMIT 1
    ) AS latest ON true
    WHERE lm.league_id = p_league_id
  ) AS ordered;

  SELECT count(*) INTO v_order_count FROM pg_temp.rookie_draft_order;
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now()
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM pg_temp.rookie_draft_order
   ORDER BY position;

  WITH pick_slots AS (
    SELECT
      rounds.round,
      ordered.member_id AS original_owner_id,
      CASE
        WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
        ELSE ordered.position
      END AS pick_in_round
    FROM generate_series(1, p_rounds) AS rounds(round)
    CROSS JOIN pg_temp.rookie_draft_order AS ordered
  ),
  resolved AS (
    SELECT
      pick_slots.round,
      pick_slots.pick_in_round,
      pick_slots.original_owner_id,
      dp.id AS draft_pick_id,
      dp.current_owner_id AS member_id
    FROM pick_slots
    JOIN LATERAL (
      SELECT id, current_owner_id
        FROM draft_picks
       WHERE league_id = p_league_id
         AND season_year = v_season.season_year
         AND round = pick_slots.round
         AND original_owner_id = pick_slots.original_owner_id
         AND is_used = false
       ORDER BY id
       LIMIT 1
       FOR UPDATE
    ) AS dp ON true
  )
  INSERT INTO snake_draft_picks (
    draft_id,
    overall_pick,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  )
  SELECT
    v_draft.id,
    ((round - 1) * v_order_count) + pick_in_round,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  FROM resolved
  ORDER BY round, pick_in_round;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = p_league_id
     AND status = 'offseason';

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> 1 THEN
    RAISE EXCEPTION 'Failed to mark league as drafting';
  END IF;

  RETURN to_jsonb(v_draft);
END;
$$;

REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_rookie_draft_atomic(uuid, int) TO service_role;
