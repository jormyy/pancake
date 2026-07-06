-- Rookie draft ledger and budget hardening:
-- - Backfill rookie draft ownership from snake_draft_picks, including players
--   already dropped/traded before the ownership-history ledger migration.
-- - Preserve inactive IR/taxi state for carried-over players in ownership
--   replay ledgers.
-- - Reject non-positive auction budgets at the DB boundary.

UPDATE public.leagues
   SET auction_budget = 200
 WHERE auction_budget <= 0;

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_auction_budget_positive;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_auction_budget_positive CHECK (auction_budget > 0);

CREATE OR REPLACE FUNCTION public.create_league(
  p_name           text,
  p_team_name      text,
  p_auction_budget int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id          uuid := (SELECT auth.uid());
  v_slug             text;
  v_invite_code      text;
  v_league_id        uuid;
  v_member_id        uuid;
  v_league_season_id uuid;
  v_season_year      int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  v_season_year := public.current_season_year_et();

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_league_season_id, v_member_id, 1);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league_id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value;

  RETURN jsonb_build_object(
    'id',              v_league_id,
    'name',            trim(p_name),
    'slug',            v_slug,
    'invite_code',     v_invite_code,
    'commissioner_id', v_user_id,
    'auction_budget',  p_auction_budget,
    'status',          'setup'
  );
END;
$$;

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

  IF v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  IF v_league.auction_budget IS NULL OR v_league.auction_budget <= 0 THEN
    RAISE EXCEPTION 'Auction budget must be a positive integer before starting a draft.'
      USING ERRCODE = 'P0001';
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
       AND status <> 'cancelled'::draft_status
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

CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
BEGIN
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status NOT IN ('playoffs'::league_status, 'archived'::league_status) THEN
    RAISE EXCEPTION 'League must be in playoffs or archived state before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found for this league';
  END IF;

  v_new_year := v_current_season.season_year + 1;
  v_far_year := v_new_year + 5;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current)
  VALUES (p_league_id, v_new_year, true)
  RETURNING id INTO v_new_season_id;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    'carry_over'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_current_season.id;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    'carry_over',
    acquired_at
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over';

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    CASE WHEN is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
    acquired_at + interval '1 millisecond'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over'
    AND (is_on_ir = true OR is_on_taxi = true);

  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    v_far_year,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN unnest(ARRAY[1, 2, 3]) AS round_value
  WHERE lm.league_id = p_league_id
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  INSERT INTO waiver_priorities (
    league_id,
    league_season_id,
    member_id,
    priority
  )
  WITH latest_standings AS (
    SELECT DISTINCT ON (member_id)
      member_id,
      wins,
      losses,
      points_for,
      points_against
    FROM standings
    WHERE league_id = p_league_id
      AND league_season_id = v_current_season.id
    ORDER BY member_id, week_number DESC
  ),
  ordered_members AS (
    SELECT
      lm.id AS member_id,
      row_number() OVER (
        ORDER BY
          COALESCE(ls.wins, 0) ASC,
          COALESCE(ls.points_for, 0) ASC,
          COALESCE(ls.losses, 0) DESC,
          COALESCE(ls.points_against, 0) DESC,
          lm.id ASC
      ) AS priority
    FROM league_members lm
    LEFT JOIN latest_standings ls ON ls.member_id = lm.id
    WHERE lm.league_id = p_league_id
  )
  SELECT p_league_id, v_new_season_id, member_id, priority
  FROM ordered_members;

  UPDATE leagues
     SET status = 'offseason'
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$$;

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  draft.league_id,
  draft.league_season_id,
  pick.member_id,
  pick.player_id,
  'draft_won',
  COALESCE(pick.picked_at, draft.started_at, draft.created_at, now())
FROM snake_draft_picks AS pick
JOIN drafts AS draft ON draft.id = pick.draft_id
WHERE pick.player_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = draft.league_id
       AND rt.league_season_id = draft.league_season_id
       AND rt.member_id = pick.member_id
       AND rt.player_id = pick.player_id
       AND rt.transaction_type = 'draft_won'
  );

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  rp.league_id,
  rp.league_season_id,
  rp.member_id,
  rp.player_id,
  CASE WHEN rp.is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
  COALESCE(rp.acquired_at, now()) + interval '1 millisecond'
FROM roster_players AS rp
JOIN league_seasons AS season
  ON season.id = rp.league_season_id
 AND season.is_current = true
WHERE rp.acquired_via = 'carry_over'
  AND (rp.is_on_ir = true OR rp.is_on_taxi = true)
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = rp.league_id
       AND rt.league_season_id = rp.league_season_id
       AND rt.member_id = rp.member_id
       AND rt.player_id = rp.player_id
       AND rt.transaction_type = CASE WHEN rp.is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END
  );

REVOKE ALL ON FUNCTION public.create_league(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_league(text, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_league(text, text, int) TO authenticated;

REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_auction_draft_atomic(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_season_atomic(uuid) TO service_role;
