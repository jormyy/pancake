BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.draft_pick_swaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_year int NOT NULL CHECK (season_year BETWEEN 2000 AND 2100),
  round int NOT NULL CHECK (round BETWEEN 1 AND 10),
  holder_member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  counterparty_member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'exercised', 'unused')),
  draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  holder_overall_pick int,
  counterparty_overall_pick int,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_pick_swaps_distinct_members CHECK (holder_member_id <> counterparty_member_id),
  CONSTRAINT draft_pick_swaps_resolution_shape CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS draft_pick_swaps_league_year_idx
  ON public.draft_pick_swaps (league_id, season_year, round);

ALTER TABLE public.draft_pick_swaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.draft_pick_swaps FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_pick_swaps TO service_role;
DROP POLICY IF EXISTS draft_pick_swaps_select ON public.draft_pick_swaps;
CREATE POLICY draft_pick_swaps_select ON public.draft_pick_swaps FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

CREATE OR REPLACE FUNCTION private.guard_draft_pick_swap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.league_members
     WHERE league_id = NEW.league_id AND id IN (NEW.holder_member_id, NEW.counterparty_member_id)
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Both swap teams must belong to the league.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_pick_swaps other
     WHERE other.id <> NEW.id
       AND other.league_id = NEW.league_id
       AND other.season_year = NEW.season_year
       AND other.round = NEW.round
       AND ARRAY[other.holder_member_id, other.counterparty_member_id]
           && ARRAY[NEW.holder_member_id, NEW.counterparty_member_id]
  ) THEN
    RAISE EXCEPTION 'A pick can be part of only one swap per round.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_draft_pick_swap ON public.draft_pick_swaps;
CREATE TRIGGER guard_draft_pick_swap
  BEFORE INSERT OR UPDATE OF league_id, season_year, round, holder_member_id, counterparty_member_id
  ON public.draft_pick_swaps
  FOR EACH ROW EXECUTE FUNCTION private.guard_draft_pick_swap();

CREATE OR REPLACE FUNCTION private.resolve_rookie_pick_swaps(p_draft_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
  v_year int;
  v_swap public.draft_pick_swaps%ROWTYPE;
  v_holder record;
  v_counter record;
  v_resolved int := 0;
BEGIN
  SELECT * INTO v_draft FROM public.drafts WHERE id = p_draft_id;
  IF NOT FOUND OR v_draft.is_mock OR v_draft.draft_type <> 'snake'::public.draft_type THEN
    RETURN 0;
  END IF;
  SELECT private.draft_year_for_season(season.season_year) INTO v_year
    FROM public.league_seasons season WHERE season.id = v_draft.league_season_id;

  FOR v_swap IN
    SELECT * FROM public.draft_pick_swaps
     WHERE league_id = v_draft.league_id AND season_year = v_year AND status = 'open'
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    SELECT slot.overall_pick, slot.draft_pick_id, pick.current_owner_id
      INTO v_holder
      FROM public.snake_draft_picks slot
      JOIN public.draft_picks pick ON pick.id = slot.draft_pick_id
     WHERE slot.draft_id = p_draft_id AND slot.round = v_swap.round
       AND pick.original_owner_id = v_swap.holder_member_id
       AND slot.player_id IS NULL AND slot.skipped_at IS NULL
     LIMIT 1;
    SELECT slot.overall_pick, slot.draft_pick_id, pick.current_owner_id
      INTO v_counter
      FROM public.snake_draft_picks slot
      JOIN public.draft_picks pick ON pick.id = slot.draft_pick_id
     WHERE slot.draft_id = p_draft_id AND slot.round = v_swap.round
       AND pick.original_owner_id = v_swap.counterparty_member_id
       AND slot.player_id IS NULL AND slot.skipped_at IS NULL
     LIMIT 1;

    IF v_holder.overall_pick IS NOT NULL AND v_counter.overall_pick IS NOT NULL
       AND v_holder.current_owner_id = v_swap.holder_member_id
       AND v_counter.overall_pick < v_holder.overall_pick THEN
      UPDATE public.draft_picks
         SET current_owner_id = CASE id WHEN v_holder.draft_pick_id THEN v_counter.current_owner_id ELSE v_holder.current_owner_id END
       WHERE id IN (v_holder.draft_pick_id, v_counter.draft_pick_id);
      UPDATE public.draft_pick_swaps
         SET status = 'exercised', draft_id = p_draft_id, resolved_at = clock_timestamp(),
             holder_overall_pick = v_holder.overall_pick, counterparty_overall_pick = v_counter.overall_pick
       WHERE id = v_swap.id;
    ELSE
      UPDATE public.draft_pick_swaps
         SET status = 'unused', draft_id = p_draft_id, resolved_at = clock_timestamp(),
             holder_overall_pick = v_holder.overall_pick, counterparty_overall_pick = v_counter.overall_pick
       WHERE id = v_swap.id;
    END IF;
    v_resolved := v_resolved + 1;
  END LOOP;
  RETURN v_resolved;
END;
$$;

CREATE TABLE IF NOT EXISTS public.nba_draft_class_imports (
  draft_year smallint PRIMARY KEY CHECK (draft_year BETWEEN 1947 AND 2100),
  source text,
  official_picks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(official_picks) = 'array'),
  board_stored_at timestamptz,
  last_attempt_at timestamptz NOT NULL,
  last_error text
);

ALTER TABLE public.nba_draft_class_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nba_draft_class_imports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.nba_draft_class_imports TO service_role;

CREATE OR REPLACE FUNCTION public.record_nba_draft_class_import(
  p_draft_year int,
  p_source text,
  p_picks jsonb,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count int;
BEGIN
  IF p_draft_year IS NULL OR p_draft_year NOT BETWEEN 1947 AND 2100 THEN
    RAISE EXCEPTION 'Invalid draft year.' USING ERRCODE = '22023';
  END IF;
  IF p_error IS NOT NULL THEN
    INSERT INTO public.nba_draft_class_imports (draft_year, last_attempt_at, last_error)
    VALUES (p_draft_year, v_now, left(p_error, 500))
    ON CONFLICT (draft_year) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error;
    RETURN jsonb_build_object('stored', false, 'draftYear', p_draft_year);
  END IF;
  IF p_picks IS NULL OR jsonb_typeof(p_picks) <> 'array' OR jsonb_array_length(p_picks) = 0 OR jsonb_array_length(p_picks) > 100 THEN
    RAISE EXCEPTION 'An official draft board needs between 1 and 100 picks.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_picks) pick
     WHERE jsonb_typeof(pick->'overallPick') IS DISTINCT FROM 'number'
        OR jsonb_typeof(pick->'round') IS DISTINCT FROM 'number'
        OR jsonb_typeof(pick->'playerName') IS DISTINCT FROM 'string'
        OR (pick ? 'personId' AND jsonb_typeof(pick->'personId') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'Each official pick needs an overall pick, round and player name.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_picks) pick
      WHERE (pick->>'overallPick')::numeric NOT BETWEEN 1 AND 100
         OR (pick->>'overallPick')::numeric <> trunc((pick->>'overallPick')::numeric)
         OR (pick->>'round')::numeric NOT BETWEEN 1 AND 10
         OR (pick->>'round')::numeric <> trunc((pick->>'round')::numeric)) THEN
    RAISE EXCEPTION 'An official draft board must list each overall pick once, numbered 1 to 100.' USING ERRCODE = '22023';
  END IF;
  SELECT count(DISTINCT (pick->>'overallPick')::int) INTO v_count FROM jsonb_array_elements(p_picks) pick;
  IF v_count <> jsonb_array_length(p_picks) THEN
    RAISE EXCEPTION 'An official draft board must list each overall pick once, numbered 1 to 100.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.nba_draft_class_imports (draft_year, source, official_picks, board_stored_at, last_attempt_at, last_error)
  VALUES (
    p_draft_year, p_source,
    (SELECT jsonb_agg(jsonb_build_object(
        'overallPick', (pick->>'overallPick')::int,
        'round', (pick->>'round')::int,
        'playerName', btrim(pick->>'playerName'),
        'personId', NULLIF(pick->>'personId', '')
      ) ORDER BY (pick->>'overallPick')::int) FROM jsonb_array_elements(p_picks) pick),
    v_now, v_now, NULL)
  ON CONFLICT (draft_year) DO UPDATE SET
    source = excluded.source, official_picks = excluded.official_picks,
    board_stored_at = excluded.board_stored_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL;
  RETURN jsonb_build_object('stored', true, 'draftYear', p_draft_year, 'picks', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.rookie_class_players(p_draft_year int)
RETURNS TABLE (player_id uuid, draft_round int, draft_overall_pick int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT player.id, player.draft_round::int, player.draft_overall_pick::int
    FROM public.players player
   WHERE player.draft_status = 'drafted'
     AND player.draft_year = p_draft_year
     AND player.nba_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.players other
        WHERE other.id <> player.id
          AND other.draft_status = 'drafted'
          AND other.draft_year = player.draft_year
          AND other.draft_overall_pick = player.draft_overall_pick
     )
$$;

CREATE OR REPLACE FUNCTION private.rookie_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(regexp_replace(regexp_replace(
    lower(regexp_replace(normalize(COALESCE(p_name, ''), NFD), '[̀-ͯ]', '', 'g')),
    '\m(jr|sr|ii|iii|iv)\M', '', 'g'), '[^a-z0-9]', '', 'g'), '')
$$;

CREATE OR REPLACE FUNCTION private.rookie_class_reconciliation(p_draft_year int)
RETURNS TABLE (overall_pick int, official_name text, official_person_id text, player_id uuid, player_nba_id text, player_name text, outcome text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH official AS (
    SELECT (pick->>'overallPick')::int AS overall_pick, pick->>'playerName' AS official_name, pick->>'personId' AS person_id
      FROM public.nba_draft_class_imports import, jsonb_array_elements(import.official_picks) pick
     WHERE import.draft_year = p_draft_year
  ),
  stored AS (
    SELECT player.id, player.nba_id, player.display_name, player.draft_year, player.draft_overall_pick,
           count(*) OVER (PARTITION BY player.draft_year, player.draft_overall_pick) AS same_slot
      FROM public.players player
     WHERE player.draft_status = 'drafted' AND player.draft_year = p_draft_year
  ),
  by_person AS (
    SELECT official.overall_pick, player.id, player.nba_id, player.display_name, player.draft_year, player.draft_overall_pick
      FROM official
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.nba_id, candidate.display_name, candidate.draft_year, candidate.draft_overall_pick
          FROM public.players candidate
         WHERE CASE WHEN official.person_id IS NOT NULL THEN candidate.nba_id = official.person_id
                    ELSE private.rookie_name_key(candidate.display_name) = private.rookie_name_key(official.official_name) END
         ORDER BY candidate.draft_year IS NOT DISTINCT FROM p_draft_year DESC, candidate.draft_year DESC NULLS LAST, candidate.id
         LIMIT 1
      ) player
     WHERE NOT EXISTS (SELECT 1 FROM stored WHERE stored.draft_overall_pick = official.overall_pick)
  )
  SELECT official.overall_pick, official.official_name, official.person_id,
         COALESCE(stored.id, by_person.id), COALESCE(stored.nba_id, by_person.nba_id), COALESCE(stored.display_name, by_person.display_name),
         CASE
           WHEN stored.id IS NOT NULL AND stored.same_slot > 1 THEN 'duplicate'
           WHEN stored.id IS NOT NULL AND CASE WHEN official.person_id IS NOT NULL THEN stored.nba_id IS DISTINCT FROM official.person_id
                ELSE private.rookie_name_key(stored.display_name) IS DISTINCT FROM private.rookie_name_key(official.official_name) END THEN 'identity_mismatch'
           WHEN stored.id IS NOT NULL THEN 'eligible'
           WHEN by_person.id IS NOT NULL AND by_person.draft_year IS DISTINCT FROM p_draft_year THEN 'wrong_year'
           WHEN by_person.id IS NOT NULL THEN 'wrong_pick'
           ELSE 'missing'
         END
    FROM official
    LEFT JOIN stored ON stored.draft_overall_pick = official.overall_pick
    LEFT JOIN by_person ON by_person.overall_pick = official.overall_pick AND stored.id IS NULL
  UNION ALL
  SELECT stored.draft_overall_pick, NULL, NULL, stored.id, stored.nba_id, stored.display_name, 'not_on_official_board'
    FROM stored
   WHERE EXISTS (SELECT 1 FROM official)
     AND NOT EXISTS (SELECT 1 FROM official WHERE official.overall_pick = stored.draft_overall_pick)
$$;

CREATE OR REPLACE FUNCTION private.rookie_class_status(p_draft_year int)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH import AS (
    SELECT * FROM public.nba_draft_class_imports WHERE draft_year = p_draft_year
  ),
  reconciled AS (
    SELECT * FROM private.rookie_class_reconciliation(p_draft_year)
  )
  SELECT jsonb_build_object(
    'draftYear', p_draft_year,
    'state', CASE
      WHEN (SELECT board_stored_at FROM import) IS NULL AND (SELECT last_error FROM import) IS NOT NULL THEN 'failed'
      WHEN (SELECT board_stored_at FROM import) IS NULL THEN 'not_imported'
      WHEN EXISTS (SELECT 1 FROM reconciled WHERE outcome <> 'eligible') THEN 'incomplete'
      ELSE 'complete'
    END,
    'officialCount', COALESCE((SELECT jsonb_array_length(official_picks) FROM import), 0),
    'eligibleCount', (SELECT count(*) FROM private.rookie_class_players(p_draft_year)),
    'lastError', (SELECT last_error FROM import),
    'lastAttemptAt', (SELECT last_attempt_at FROM import),
    'boardStoredAt', (SELECT board_stored_at FROM import),
    'discrepancies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('overallPick', overall_pick, 'officialName', official_name,
        'personId', official_person_id, 'playerName', player_name, 'outcome', outcome) ORDER BY overall_pick)
        FROM reconciled WHERE outcome <> 'eligible'), '[]'::jsonb)
  )
$$;

CREATE OR REPLACE FUNCTION private.draft_class_year(p_draft_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT private.draft_year_for_season(season.season_year)
    FROM public.drafts draft
    JOIN public.league_seasons season ON season.id = draft.league_season_id
   WHERE draft.id = p_draft_id
$$;

CREATE OR REPLACE FUNCTION private.rookie_draft_pool(p_draft_id uuid)
RETURNS TABLE (player_id uuid, draft_round int, draft_overall_pick int)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT class.player_id, class.draft_round, class.draft_overall_pick
    FROM public.drafts draft
    CROSS JOIN LATERAL private.rookie_class_players(private.draft_class_year(draft.id)) class
   WHERE draft.id = p_draft_id
     AND NOT EXISTS (SELECT 1 FROM public.snake_draft_picks picked WHERE picked.draft_id = draft.id AND picked.player_id = class.player_id)
     AND (draft.is_mock OR NOT EXISTS (
       SELECT 1 FROM public.roster_players roster
        WHERE roster.league_id = draft.league_id AND roster.league_season_id = draft.league_season_id
          AND roster.player_id = class.player_id))
$$;

CREATE INDEX IF NOT EXISTS idx_players_draft_class
  ON public.players (draft_year, draft_overall_pick)
  WHERE draft_status = 'drafted';

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(p_league_id uuid, p_rounds integer DEFAULT 3, p_is_mock boolean DEFAULT false, p_pick_timer_seconds integer DEFAULT 60, p_timer_expiry_behavior text DEFAULT 'auto_pick'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_last_season_id uuid;
  v_pick_count int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  IF p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 60 OR p_pick_timer_seconds > 604800 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 60 and 604800.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status <> 'offseason' THEN
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

  IF NOT v_is_mock THEN
    PERFORM 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'snake'
       AND is_mock = false
       AND status IN ('pending', 'in_progress', 'paused')
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'A rookie draft already exists for this season';
    END IF;
  END IF;

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM draft_picks AS pick
     WHERE pick.league_id = p_league_id
       AND pick.season_year = private.draft_year_for_season(v_season.season_year)
       AND pick.is_used = false
       AND private.is_reserved_trade_asset(pick.league_id, NULL, pick.current_owner_id, NULL, pick.id)
  ) THEN
    RAISE EXCEPTION 'A pick in this draft class is reserved by an accepted trade. Complete or veto that trade before starting the rookie draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM private.league_playoff_round_plan(v_league.id, v_member_count);
  END IF;

  SELECT id
    INTO v_last_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = false
   ORDER BY season_year DESC
   LIMIT 1;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior,
    rookie_draft_order
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now(),
    v_is_mock,
    p_pick_timer_seconds,
    p_rounds,
    v_timer_expiry_behavior,
    v_league.rookie_draft_order
  )
  RETURNING * INTO v_draft;

  v_order_count := public.generate_linear_draft_order(v_draft.id);
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  IF v_is_mock THEN
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
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
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id AS original_owner_id,
        CASE
          WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
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
           AND season_year = private.draft_year_for_season(v_season.season_year)
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
  END IF;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM private.resolve_rookie_pick_swaps(v_draft.id);
  END IF;

  PERFORM private.arm_next_snake_pick_timer(
    v_draft.id,
    clock_timestamp() + make_interval(secs => p_pick_timer_seconds)
  );

  IF NOT v_is_mock THEN
    UPDATE draft_picks SET is_used=true,used_at=now()
      WHERE league_id=p_league_id AND season_year=private.draft_year_for_season(v_season.season_year) AND round>p_rounds AND NOT is_used;
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id
       AND status = 'offseason';

    GET DIAGNOSTICS v_pick_count = ROW_COUNT;
    IF v_pick_count <> 1 THEN
      RAISE EXCEPTION 'Failed to mark league as drafting';
    END IF;
  END IF;

  RETURN to_jsonb(v_draft);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reseed_rookie_draft_picks_atomic(p_draft_id uuid, p_rounds integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft drafts%ROWTYPE;
  v_rounds int;
  v_season_year int;
  v_order_count int;
  v_pick_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress';
  END IF;

  v_rounds := COALESCE(p_rounds, v_draft.rounds, 3);
  IF v_rounds < 1 OR v_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;

  PERFORM 1
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NOT NULL
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot reseed - picks have already been made';
  END IF;

  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = v_draft.league_season_id
   FOR SHARE;

  SELECT count(*)
    INTO v_order_count
    FROM draft_orders
   WHERE draft_id = p_draft_id;

  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Draft orders not found';
  END IF;

  DELETE FROM snake_draft_picks
   WHERE draft_id = p_draft_id;

  WITH pick_slots AS (
    SELECT
      rounds.round,
      ordered.member_id AS original_owner_id,
      CASE
        WHEN v_draft.rookie_draft_order = 'snake' AND rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
        ELSE ordered.position
      END AS pick_in_round
    FROM generate_series(1, v_rounds) AS rounds(round)
    CROSS JOIN draft_orders AS ordered
    WHERE ordered.draft_id = p_draft_id
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
       WHERE league_id = v_draft.league_id
         AND season_year = private.draft_year_for_season(v_season_year)
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
    p_draft_id,
    ((round - 1) * v_order_count) + pick_in_round,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  FROM resolved
  ORDER BY round, pick_in_round;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * v_rounds THEN
    RAISE EXCEPTION 'Failed to reseed every rookie draft pick slot';
  END IF;

  PERFORM private.resolve_rookie_pick_swaps(p_draft_id);

  RETURN v_pick_count;
END;
$function$;

CREATE OR REPLACE FUNCTION private.make_snake_pick_atomic_internal(p_draft_id uuid, p_member_id uuid, p_player_id uuid, p_allow_expired_timer boolean DEFAULT false, p_to_taxi boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league_id uuid;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz;
  v_remaining int;
  v_completed boolean := false;
  v_activated boolean := false;
  v_completion jsonb;
  v_rows int;
  v_next_timer_expires_at timestamptz;
BEGIN
  SELECT league_id INTO v_league_id FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM private.lock_roster_scope(v_league_id, '{}', ARRAY[p_player_id], p_draft_id);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining - draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL THEN
    RAISE EXCEPTION 'Draft slot is missing its draft-pick asset'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM private.rookie_class_players(private.draft_class_year(p_draft_id)) AS class
   WHERE class.player_id = p_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only players selected in this year''s NBA draft can be picked'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT id
      INTO v_on_roster_id
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
     FOR UPDATE;

    IF v_on_roster_id IS NOT NULL THEN
      RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  v_now := clock_timestamp();
  IF NOT p_allow_expired_timer
     AND v_next_pick.timer_expires_at IS NOT NULL
     AND v_next_pick.timer_expires_at <= v_now THEN
    RAISE EXCEPTION 'Pick timer has expired'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now,
         to_taxi = COALESCE(p_to_taxi,false),
         skipped_at = NULL,
         skip_reason = NULL,
         timer_expires_at = NULL
   WHERE id = v_next_pick.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    IF p_to_taxi THEN
      PERFORM private.authorize_taxi_acquisition(v_draft.league_id,v_draft.league_season_id,p_member_id,p_player_id,'draft',p_draft_id);
    END IF;
    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      is_on_taxi,
      acquired_via
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      COALESCE(p_to_taxi,false),
      'draft'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      acquired_to_taxi,
      occurred_at
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft_won',
      COALESCE(p_to_taxi,false),
      v_now
    );

    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    v_next_timer_expires_at := private.arm_next_snake_pick_timer(
      p_draft_id,
      v_now + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  IF v_remaining = 0 THEN
    v_completion := private.complete_rookie_draft_if_ready(p_draft_id, v_now);
    v_completed := COALESCE((v_completion->>'completed')::boolean, false);
    v_activated := COALESCE((v_completion->>'activated')::boolean, false);
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'player_id', p_player_id,
    'to_taxi', COALESCE(p_to_taxi,false),
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id,
    'is_mock', v_draft.is_mock,
    'next_timer_expires_at', v_next_timer_expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_pick_snake_pick_atomic(p_draft_id uuid, p_member_id uuid, p_reason text DEFAULT 'manual'::text, p_to_taxi boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.auto_pick_snake_pick_atomic', jsonb_build_array(p_draft_id, p_member_id, p_reason, p_to_taxi));
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_reason text := COALESCE(NULLIF(trim(p_reason), ''), 'manual');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type THEN
    RAISE EXCEPTION 'Auto-pick is only available for snake drafts'
      USING ERRCODE = 'P0001';
  END IF;

  -- Resume real drafts when the season-start backstop runs.
  IF v_reason = 'season_boundary_backstop' AND NOT v_draft.is_mock AND v_draft.status = 'paused' THEN
    UPDATE drafts SET status = 'in_progress', paused_at = NULL,
      timer_paused_remaining_seconds = NULL, pause_reason = NULL WHERE id = p_draft_id;
  END IF;

  SELECT pool.player_id
    INTO v_player_id
    FROM private.rookie_draft_pool(p_draft_id) AS pool
   WHERE NOT COALESCE(p_to_taxi,false) OR v_draft.is_mock OR
     private.can_acquire_draft_taxi(v_draft.league_id,v_draft.league_season_id,p_member_id,pool.player_id)
   ORDER BY pool.draft_overall_pick, pool.player_id
   LIMIT 1;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'No available players for auto-pick'
      USING ERRCODE = 'P0001';
  END IF;

  v_result := private.make_snake_pick_atomic_internal(
    p_draft_id,
    p_member_id,
    v_player_id,
    v_reason IN ('timer_expired', 'season_boundary_backstop'),
    p_to_taxi
  );

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    NULL,
    'auto_pick',
    jsonb_build_object(
      'reason', v_reason,
      'source', 'nba_draft_class',
      'memberId', p_member_id,
      'playerId', v_player_id,
      'pick', v_result->'pick'
    )
  );

  __request_result := v_result || jsonb_build_object('player_id', v_player_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$function$;

CREATE OR REPLACE FUNCTION private.prevent_pre_draft_rookie_acquisition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.acquired_via IN ('free_agent', 'waiver') AND EXISTS (
    SELECT 1
      FROM public.leagues AS league
      JOIN public.league_seasons AS season ON season.league_id = league.id AND season.is_current
      JOIN public.players AS player ON player.id = NEW.player_id
     WHERE league.id = NEW.league_id
       AND season.id = NEW.league_season_id
       AND league.status = 'offseason'
       AND player.draft_status = 'drafted'
       AND player.draft_year = private.draft_year_for_season(season.season_year)
       AND NOT EXISTS (
         SELECT 1 FROM public.drafts AS draft
          WHERE draft.league_id = league.id
            AND draft.league_season_id = season.id
            AND draft.draft_type = 'snake'
            AND NOT draft.is_mock
            AND draft.status = 'completed'
       )
  ) THEN
    RAISE EXCEPTION 'Drafted rookies are available after your league completes its rookie draft.'
      USING ERRCODE = 'PA008';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.view_draft_room(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE context jsonb; draft public.drafts%ROWTYPE; orders jsonb; budgets jsonb; nominations jsonb; picks jsonb;
  open_nomination jsonb; active_bids jsonb; current_member uuid; prospects jsonb; search_results jsonb; class_year int; class_status jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO draft FROM public.drafts WHERE id = (p_params->>'draftId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'draft', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('position', entry.position, 'memberId', entry.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown')) ORDER BY entry.position), '[]') INTO orders
    FROM public.draft_orders entry LEFT JOIN public.league_members member ON member.id = entry.member_id WHERE entry.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', budget.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'remaining', budget.remaining, 'initialBudget', budget.initial_budget) ORDER BY entry.position), '[]') INTO budgets
    FROM public.draft_budgets budget LEFT JOIN public.league_members member ON member.id = budget.member_id
      LEFT JOIN public.draft_orders entry ON entry.draft_id = budget.draft_id AND entry.member_id = budget.member_id WHERE budget.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', nomination.id, 'status', nomination.status,
    'nominatingMemberId', nomination.nominating_member_id, 'currentBidAmount', nomination.current_bid_amount,
    'currentBidderId', nomination.current_bidder_id, 'currentBidToTaxi', nomination.current_bid_to_taxi,
    'countdownExpiresAt', nomination.countdown_expires_at, 'winningMemberId', nomination.winning_member_id,
    'finalPrice', nomination.final_price, 'nominatedAt', nomination.nominated_at, 'nominationOrder', nomination.nomination_order,
    'player', jsonb_build_object('displayName', COALESCE(player.display_name, 'Unknown'), 'nbaTeam', player.nba_team,
      'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status,
      'age', (SELECT age FROM public.dynasty_rankings WHERE player_id = player.id AND source = 'hashtagbasketball.com' AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)))
    ORDER BY nomination.nomination_order, nomination.id), '[]') INTO nominations
  FROM (SELECT * FROM public.nominations WHERE draft_id = draft.id ORDER BY nomination_order DESC LIMIT 500) nomination
    LEFT JOIN public.players player ON player.id = nomination.player_id;
  SELECT item INTO open_nomination FROM jsonb_array_elements(nominations) item WHERE item->>'status' = 'open' LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', bid.id, 'nominationId', bid.nomination_id, 'memberId', bid.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'amount', bid.amount, 'placedAt', bid.placed_at)
    ORDER BY bid.placed_at DESC, bid.id), '[]') INTO active_bids
  FROM (SELECT * FROM public.bids WHERE nomination_id = (open_nomination->>'id')::uuid ORDER BY placed_at DESC LIMIT 100) bid
    LEFT JOIN public.league_members member ON member.id = bid.member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('overallPick', pick.overall_pick, 'round', pick.round, 'pickInRound', pick.pick_in_round,
    'memberId', pick.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'), 'pickedAt', pick.picked_at,
    'skippedAt', pick.skipped_at, 'skipReason', pick.skip_reason, 'timerExpiresAt', pick.timer_expires_at,
    'player', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('id', player.id, 'displayName', COALESCE(player.display_name, 'Unknown'),
      'nbaTeam', player.nba_team, 'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status) END,
    'originalMemberId', asset.original_owner_id, 'originalTeamName', original_member.team_name,
    'swap', (SELECT jsonb_build_object('status', swap.status, 'holderMemberId', swap.holder_member_id,
        'holderTeamName', holder.team_name, 'counterpartyMemberId', swap.counterparty_member_id,
        'counterpartyTeamName', counterparty.team_name,
        'side', CASE WHEN swap.holder_overall_pick = pick.overall_pick THEN 'holder' ELSE 'counterparty' END)
      FROM public.draft_pick_swaps swap
      LEFT JOIN public.league_members holder ON holder.id = swap.holder_member_id
      LEFT JOIN public.league_members counterparty ON counterparty.id = swap.counterparty_member_id
      WHERE swap.draft_id = draft.id AND pick.overall_pick IN (swap.holder_overall_pick, swap.counterparty_overall_pick)
      ORDER BY swap.created_at LIMIT 1)) ORDER BY pick.overall_pick), '[]') INTO picks
    FROM public.snake_draft_picks pick LEFT JOIN public.league_members member ON member.id = pick.member_id
      LEFT JOIN public.players player ON player.id = pick.player_id
      LEFT JOIN public.draft_picks asset ON asset.id = pick.draft_pick_id
      LEFT JOIN public.league_members original_member ON original_member.id = asset.original_owner_id
    WHERE pick.draft_id = draft.id;
  IF jsonb_array_length(orders) > 0 THEN current_member := (orders->((draft.current_nomination_order - 1) % jsonb_array_length(orders))->>'memberId')::uuid; END IF;
  IF draft.draft_type = 'snake'::public.draft_type THEN
    class_year := private.draft_class_year(draft.id);
    class_status := private.rookie_class_status(class_year) || jsonb_build_object(
      'availableCount', (SELECT count(*) FROM private.rookie_draft_pool(draft.id)));
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', player.id, 'display_name', player.display_name, 'nba_team', player.nba_team,
      'position', player.position, 'nba_id', player.nba_id, 'injury_status', player.injury_status, 'years_exp', player.years_exp,
      'career_regular_season_games', player.career_regular_season_games, 'draft_year', class_year,
      'draft_round', pool.draft_round, 'draft_overall_pick', pool.draft_overall_pick,
      'taxi_eligible', COALESCE(private.taxi_player_eligible(draft.league_id, player.id), false))
      ORDER BY pool.draft_overall_pick, player.id), '[]') INTO prospects
      FROM private.rookie_draft_pool(draft.id) pool JOIN public.players player ON player.id = pool.player_id
     WHERE COALESCE(p_params->>'query', '') = '' OR player.display_name ILIKE '%' || (p_params->>'query') || '%';
  ELSE
    prospects := '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || jsonb_build_object('age', (SELECT age FROM public.dynasty_rankings
    WHERE player_id = player.id AND source = 'hashtagbasketball.com' AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)) ORDER BY ordinal), '[]') INTO search_results
    FROM (SELECT p.id, p.display_name, p.nba_team, p.position, p.nba_id, p.injury_status, p.years_exp,
      p.career_regular_season_games, p.dynasty_rank, p.dynasty_rank_source, p.dynasty_rank_fetched_at,
      row_number() OVER (ORDER BY CASE WHEN draft.nomination_order_mode <> 'alphabetical' THEN p.dynasty_rank END NULLS LAST, p.last_name, p.display_name, p.id) AS ordinal
      FROM public.players p WHERE NOT EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = draft.id AND player_id = p.id)
        AND (COALESCE(p_params->>'query', '') = '' OR p.display_name ILIKE '%' || (p_params->>'query') || '%')
      ORDER BY ordinal LIMIT 20) player;
  RETURN jsonb_build_object('context', context, 'draft', jsonb_build_object('id', draft.id, 'leagueId', draft.league_id,
    'leagueSeasonId', draft.league_season_id, 'seasonYear', (SELECT season_year FROM public.league_seasons WHERE id = draft.league_season_id),
    'isCurrentSeason', COALESCE((SELECT is_current FROM public.league_seasons WHERE id = draft.league_season_id), false),
    'status', draft.status, 'draftType', draft.draft_type, 'isMock', draft.is_mock, 'currentNominationOrder', draft.current_nomination_order,
    'nominationOrderMode', draft.nomination_order_mode, 'budgetPerTeam', draft.budget_per_team, 'scheduledAt', draft.scheduled_at,
    'roomName', draft.room_name, 'createdByMemberId', draft.created_by_member_id, 'pickTimerSeconds', draft.pick_timer_seconds,
    'timerExpiryBehavior', draft.timer_expiry_behavior, 'rounds', draft.rounds, 'startedAt', draft.started_at, 'completedAt', draft.completed_at,
    'pauseReason', draft.pause_reason, 'pausedAt', draft.paused_at, 'pausedRemainingSeconds', draft.timer_paused_remaining_seconds),
    'order', orders, 'orders', orders, 'budgets', budgets, 'nominations', nominations, 'openNomination', open_nomination,
    'activeBids', active_bids, 'currentNominatorMemberId', current_member, 'picks', picks,
    'prospects', prospects, 'classStatus', class_status, 'searchResults', search_results,
    'nextPick', (SELECT item FROM jsonb_array_elements(picks) item WHERE item->>'player' IS NULL AND item->>'skippedAt' IS NULL LIMIT 1));
END;
$function$;

CREATE OR REPLACE FUNCTION public.make_rookie_selection_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_destination text,
  p_drop_roster_player_ids uuid[] DEFAULT '{}',
  p_expected_overall_pick int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.make_rookie_selection_atomic',
    jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_destination, p_drop_roster_player_ids, p_expected_overall_pick), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_next snake_draft_picks%ROWTYPE;
  v_drop_ids uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_drop_roster_player_ids, '{}')));
  v_drop_player_ids uuid[];
  v_drop roster_players%ROWTYPE;
  v_rookie roster_players%ROWTYPE;
  v_found int;
  v_active int;
  v_taxi int;
BEGIN
  IF p_destination IS NULL OR p_destination NOT IN ('active', 'taxi', 'drop') THEN
    RAISE EXCEPTION 'Choose where the rookie goes.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(player_id), '{}') INTO v_drop_player_ids
    FROM roster_players WHERE id = ANY(v_drop_ids);
  PERFORM private.lock_roster_scope(v_draft.league_id, ARRAY[p_member_id], ARRAY[p_player_id] || v_drop_player_ids, p_draft_id);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  SELECT * INTO v_next
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id AND player_id IS NULL AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1;
  IF p_expected_overall_pick IS NOT NULL AND (v_next.id IS NULL OR v_next.overall_pick <> p_expected_overall_pick) THEN
    RAISE EXCEPTION 'Pick % was already made. Refresh the board.', p_expected_overall_pick USING ERRCODE = 'PA013';
  END IF;

  IF v_draft.is_mock THEN
    IF cardinality(v_drop_ids) > 0 THEN
      RAISE EXCEPTION 'Practice drafts do not change rosters.' USING ERRCODE = '22023';
    END IF;
    __request_result := private.make_snake_pick_atomic_internal(p_draft_id, p_member_id, p_player_id, false, false)
      || jsonb_build_object('destination', p_destination, 'dropped', '[]'::jsonb);
    EXIT request_write;
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = v_draft.league_id;
  IF p_player_id = ANY(v_drop_player_ids) THEN
    RAISE EXCEPTION 'Choose Drop rookie to release the player you are drafting.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found
    FROM roster_players
   WHERE id = ANY(v_drop_ids)
     AND league_id = v_draft.league_id
     AND league_season_id = v_draft.league_season_id
     AND member_id = p_member_id;
  IF v_found <> cardinality(v_drop_ids) THEN
    RAISE EXCEPTION 'A player you chose to drop is no longer on your roster. Refresh and try again.' USING ERRCODE = 'PA010';
  END IF;

  __request_result := private.make_snake_pick_atomic_internal(p_draft_id, p_member_id, p_player_id, false, p_destination = 'taxi');

  FOR v_drop IN
    SELECT * FROM roster_players WHERE id = ANY(v_drop_ids) ORDER BY id FOR UPDATE
  LOOP
    PERFORM private.release_roster_player_to_waivers(
      v_drop.id, v_drop.league_id, v_drop.league_season_id, v_drop.member_id, v_drop.player_id, 'fa_drop');
  END LOOP;

  IF p_destination = 'drop' THEN
    SELECT * INTO v_rookie
      FROM roster_players
     WHERE league_id = v_draft.league_id AND league_season_id = v_draft.league_season_id
       AND member_id = p_member_id AND player_id = p_player_id
     FOR UPDATE;
    PERFORM private.release_roster_player_to_waivers(
      v_rookie.id, v_rookie.league_id, v_rookie.league_season_id, v_rookie.member_id, v_rookie.player_id, 'fa_drop');
  END IF;

  SELECT count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi), count(*) FILTER (WHERE is_on_taxi)
    INTO v_active, v_taxi
    FROM roster_players
   WHERE league_id = v_draft.league_id AND league_season_id = v_draft.league_season_id AND member_id = p_member_id;
  IF v_active > v_league.roster_size THEN
    RAISE EXCEPTION 'Your active roster would be % over the limit of %. Choose a player to drop.', v_active - v_league.roster_size, v_league.roster_size
      USING ERRCODE = 'PA012';
  END IF;
  IF v_taxi > v_league.taxi_slots THEN
    RAISE EXCEPTION 'Your taxi squad would be % over the limit of %. Choose a player to drop.', v_taxi - v_league.taxi_slots, v_league.taxi_slots
      USING ERRCODE = 'PA012';
  END IF;

  IF COALESCE((__request_result->>'completed')::boolean, false) AND NOT COALESCE((__request_result->>'activated')::boolean, false) THEN
    __request_result := __request_result || jsonb_build_object('activated', private.activate_rookie_draft_league_if_ready(p_draft_id));
  END IF;
  __request_result := __request_result || jsonb_build_object(
    'destination', p_destination,
    'dropped', to_jsonb(v_drop_ids),
    'active_count', v_active,
    'taxi_count', v_taxi,
    'roster_size', v_league.roster_size,
    'taxi_slots', v_league.taxi_slots
  );
END request_write;
  PERFORM private.request_finish(__request_context, __request_result);
  RETURN __request_result;
END;
$$;

REVOKE ALL ON FUNCTION private.guard_draft_pick_swap() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.resolve_rookie_pick_swaps(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rookie_class_players(int) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rookie_name_key(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rookie_class_reconciliation(int) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rookie_class_status(int) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.draft_class_year(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.rookie_draft_pool(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_nba_draft_class_import(int, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_nba_draft_class_import(int, text, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.make_rookie_selection_atomic(uuid, uuid, uuid, text, uuid[], int) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.make_rookie_selection_atomic(uuid, uuid, uuid, text, uuid[], int) TO service_role;

COMMIT;
