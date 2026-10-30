CREATE OR REPLACE FUNCTION public.view_roster(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
DECLARE asset_locks jsonb; context jsonb; roster jsonb; averages jsonb; stats jsonb; slots jsonb; assignments jsonb; picks jsonb;
  target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id); transaction_state jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetKind',asset_kind,'assetId',asset_id,
    'sourceKind',source_kind,'sourceId',source_id,'reason',reason) ORDER BY source_kind,source_id), '[]'::jsonb)
    INTO asset_locks FROM private.locked_assets(p_league_id,(context->>'seasonId')::uuid,p_member_id)
    WHERE target=p_member_id;
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This roster is not available.' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='player' AND lock->>'assetId'=p.id::text),'[]'), 'id', r.id, 'is_on_ir', r.is_on_ir, 'is_on_taxi', r.is_on_taxi,
    'taxi_start_season_year', r.taxi_start_season_year, 'acquired_via', r.acquired_via, 'players', jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'nba_team', p.nba_team, 'position', p.position,
      'eligible_positions', p.eligible_positions, 'injury_status', p.injury_status, 'nba_id', p.nba_id,
      'nba_draft_number', p.nba_draft_number, 'birthdate', p.birthdate, 'years_exp', p.years_exp, 'career_regular_season_games', p.career_regular_season_games))
      ORDER BY r.is_on_taxi, r.is_on_ir), '[]'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points))
      FILTER (WHERE COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points) IS NOT NULL), '{}'),
    COALESCE(jsonb_object_agg(p.id::text, COALESCE(average.averages, to_jsonb(source_average)))
      FILTER (WHERE COALESCE(average.averages, to_jsonb(source_average)) IS NOT NULL), '{}')
  INTO roster, averages, stats FROM public.roster_players r JOIN public.players p ON p.id = r.player_id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = p.id
      AND average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = p.id
      AND source_average.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = p.id AND source_fantasy.season_year = COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
  WHERE r.member_id = target AND r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  picks := COALESCE((SELECT jsonb_agg(jsonb_build_object('assetLocks', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock WHERE lock->>'assetKind'='pick' AND lock->>'assetId'=pick->>'id'),'[]'), 'kind', 'pick', 'pickId', pick->'id', 'seasonYear', pick->'seasonYear',
      'round', pick->'round', 'originalTeamName', pick->'originalTeamName')) FROM jsonb_array_elements(
      public.view_picks(p_league_id, p_member_id, p_params || jsonb_build_object('targetMemberId', target))->'picks') pick), '[]');
  IF COALESCE((p_params->>'inventoryOnly')::boolean, false) THEN
    RETURN jsonb_build_object('roster', roster, 'picks', picks, 'avgMap', averages, 'avgStatsMap', stats);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slotType', slot_type, 'slotCount', slot_count)), '[]') INTO slots
    FROM public.lineup_slot_templates WHERE league_id = p_league_id;
  SELECT COALESCE(jsonb_object_agg(player_id::text, slot_type), '{}') INTO assignments FROM public.weekly_lineups
    WHERE league_id = p_league_id AND member_id = target AND league_season_id = (context->>'seasonId')::uuid
      AND game_date = COALESCE((p_params->>'date')::date, (context->>'today')::date);
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('tradeLockedAssets', COALESCE((SELECT jsonb_agg(lock) FROM jsonb_array_elements(asset_locks) lock
    WHERE lock->>'sourceKind'<>'trade' OR EXISTS(SELECT 1 FROM public.trades trade
      WHERE trade.id=(lock->>'sourceId')::uuid AND trade.status='accepted')),'[]'::jsonb), 'lockedAssets', asset_locks, 'context', context, 'roster', roster,
    'picks', picks,
    'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims', 'avgMap', averages, 'avgStatsMap', stats,
    'waiverPriority', (SELECT priority FROM public.waiver_priorities WHERE member_id = p_member_id AND league_season_id = (context->>'seasonId')::uuid),
    'faabBalance', CASE WHEN context->'league'->>'waiver_mode' = 'faab' THEN transaction_state->'faabBalance' END, 'transactionState', transaction_state,
    'slotPlan', jsonb_build_object('slots', slots, 'assignments', assignments),
    'taxiExitPlayerIds', COALESCE((SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.league_member_taxi_exits
      WHERE member_id = target AND league_id = p_league_id), '[]'));
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_only_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_faab record;
BEGIN
  FOR v_faab IN
    SELECT from_member_id,sum(faab_amount)::int amount FROM trade_items
      WHERE trade_id=p_trade_id AND faab_amount>0 GROUP BY from_member_id ORDER BY from_member_id
  LOOP
    IF private.available_faab_balance(p_league_id,p_league_season_id,v_faab.from_member_id,p_trade_id)<v_faab.amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  PERFORM private.validate_trade_rosters(p_trade_id, p_only_member_id);
  PERFORM private.assert_accepted_trade_capacity(p_league_id,p_league_season_id,participant.member_id,p_trade_id)
    FROM trade_participants participant WHERE participant.trade_id=p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id=p_only_member_id);
  PERFORM 1
    FROM trade_items AS item
    JOIN roster_players AS roster
      ON roster.league_id = p_league_id
     AND roster.league_season_id = p_league_season_id
     AND roster.member_id = item.from_member_id
     AND roster.player_id = item.player_id
   WHERE item.trade_id = p_trade_id
     AND item.player_id IS NOT NULL
   ORDER BY roster.id
   FOR UPDATE OF roster;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.member_id = item.from_member_id
            AND roster.player_id = item.player_id
            AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.player_id IS NOT NULL;

  PERFORM 1
    FROM trade_items AS item
    JOIN draft_picks AS pick
      ON pick.id = item.pick_id
     AND pick.league_id = p_league_id
     AND pick.current_owner_id = item.from_member_id
     AND pick.is_used = false
   WHERE item.trade_id = p_trade_id
     AND item.pick_id IS NOT NULL
   ORDER BY pick.id
   FOR UPDATE OF pick;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM draft_picks AS pick
          WHERE pick.id = item.pick_id
            AND pick.league_id = p_league_id
            AND pick.current_owner_id = item.from_member_id
            AND pick.is_used = false
       )
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.pick_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.is_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.locked_assets(p_league_id,
      COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    JOIN public.trades reservation ON reservation.id=locked.source_id AND reservation.status='accepted'
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
  )
$$;

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE lock_reason text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, CASE WHEN private.trade_lifecycle_write_active() THEN (SELECT participant.trade_id FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id WHERE trade.status='accepted' AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id AND OLD.player_id=ANY(participant.drop_player_ids)) ELSE NULL END);

  SELECT locked.reason INTO lock_reason FROM private.locked_assets(OLD.league_id, OLD.league_season_id, OLD.member_id) locked
    WHERE locked.asset_id=OLD.player_id AND NOT (locked.source_kind='trade'
      AND COALESCE(private.trade_lifecycle_write_active(),false)
      AND locked.source_id::text=current_setting('pancake.applied_trade_id',true)) ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_offer_faab_amount int := COALESCE(p_offer_faab_amount, 0);
  v_request_faab_amount int := COALESCE(p_request_faab_amount, 0);
  v_rows int;
  v_league leagues%ROWTYPE;
  v_terms jsonb;
  v_champion_finalized boolean := false;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF cardinality(v_offer_player_ids) + cardinality(v_request_player_ids) +
     cardinality(v_offer_pick_ids) + cardinality(v_request_pick_ids) +
     (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) +
     (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) > 100 THEN
    RAISE EXCEPTION 'A trade cannot include more than 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF v_offer_faab_amount < 0 OR v_offer_faab_amount > 1000000 OR
     v_request_faab_amount < 0 OR v_request_faab_amount > 1000000 THEN
    RAISE EXCEPTION 'FAAB trade amounts must be between 0 and 1000000.'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) + (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) + (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) = 0 THEN
    RAISE EXCEPTION 'A trade must include at least one asset on each side.';
  END IF;

  IF (SELECT count(*) FROM unnest(v_offer_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_offer_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered picks are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY[p_proposer_member_id, p_recipient_member_id],
    v_offer_player_ids || v_request_player_ids
  );

  SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
    'fromMemberId',route.sender,'toMemberId',route.receiver,'playerId',route.player_id,
    'pickId',route.pick_id,'faabAmount',route.faab_amount))) INTO v_terms
  FROM (
    SELECT p_proposer_member_id sender,p_recipient_member_id receiver,player_id,NULL::uuid pick_id,0 faab_amount FROM unnest(v_offer_player_ids) player_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,player_id,NULL::uuid,0 FROM unnest(v_request_player_ids) player_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,pick_id,0 FROM unnest(v_offer_pick_ids) pick_id
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,pick_id,0 FROM unnest(v_request_pick_ids) pick_id
    UNION ALL SELECT p_proposer_member_id,p_recipient_member_id,NULL::uuid,NULL::uuid,v_offer_faab_amount WHERE v_offer_faab_amount>0
    UNION ALL SELECT p_recipient_member_id,p_proposer_member_id,NULL::uuid,NULL::uuid,v_request_faab_amount WHERE v_request_faab_amount>0
  ) route;
  IF EXISTS(SELECT 1 FROM trades pending WHERE pending.league_id=p_league_id
    AND pending.league_season_id=p_league_season_id AND pending.status='pending'
    AND (pending.expires_at IS NULL OR pending.expires_at>now())
    AND pending.proposer_member_id=p_proposer_member_id AND pending.recipient_member_id=p_recipient_member_id
    AND pending.id IS DISTINCT FROM p_edited_from_trade_id AND pending.id IS DISTINCT FROM p_countered_from_trade_id
    AND v_terms=(SELECT private.canonical_trade_estimate_terms(jsonb_agg(jsonb_build_object(
      'fromMemberId',item.from_member_id,'toMemberId',item.to_member_id,'playerId',item.player_id,
      'pickId',item.pick_id,'faabAmount',item.faab_amount))) FROM trade_items item WHERE item.trade_id=pending.id)) THEN
    RAISE EXCEPTION 'An identical offer is already pending. Open that trade instead.' USING ERRCODE='P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  PERFORM private.assert_trade_window(p_league_id, v_offer_pick_ids || v_request_pick_ids);

  IF v_league.status NOT IN (
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_offer_faab_amount > 0 OR v_request_faab_amount > 0) AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;


  PERFORM 1
    FROM league_members
   WHERE id = p_proposer_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposer not found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_recipient_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient not found.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_proposer_member_id
       AND player_id = ANY(v_offer_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (is_on_ir = false AND is_on_taxi = false))
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_proposer_member_id
       AND is_used = false
       AND id = ANY(v_offer_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_pick_ids) THEN
    RAISE EXCEPTION 'Your offer includes a draft pick that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_recipient_member_id
       AND is_used = false
       AND id = ANY(v_request_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_pick_ids) THEN
    RAISE EXCEPTION 'Your request includes a draft pick that is no longer owned by the expected team.';
  END IF;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version,
    proposer_faab_amount,
    recipient_faab_amount
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    GREATEST(COALESCE(p_version, 1), 1),
    v_offer_faab_amount,
    v_request_faab_amount
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_items (trade_id, side, player_id, pick_id, from_member_id, to_member_id, faab_amount)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id, p_proposer_member_id, p_recipient_member_id, 0
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id, p_recipient_member_id, p_proposer_member_id, 0
    FROM unnest(v_request_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, NULL::uuid, p_proposer_member_id, p_recipient_member_id, v_offer_faab_amount
   WHERE v_offer_faab_amount > 0
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, NULL::uuid, p_recipient_member_id, p_proposer_member_id, v_request_faab_amount
   WHERE v_request_faab_amount > 0;

  INSERT INTO trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
  VALUES
    (v_trade_id, p_proposer_member_id, 0, true, now()),
    (v_trade_id, p_recipient_member_id, 1, false, NULL);

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'Counteroffer sent'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'Trade offer edited'
      ELSE 'Trade offer sent'
    END,
    NULL,
    p_proposer_member_id,
    p_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'parent_trade_id', p_parent_trade_id,
      'countered_from_trade_id', p_countered_from_trade_id,
      'edited_from_trade_id', p_edited_from_trade_id,
      'version', GREATEST(COALESCE(p_version, 1), 1),
      'proposer_faab_amount', v_offer_faab_amount,
      'recipient_faab_amount', v_request_faab_amount
    )
  );

  RETURN v_trade_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
END;
$$;

CREATE OR REPLACE FUNCTION private.locked_assets(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS TABLE(asset_kind text, asset_id uuid, source_kind text, source_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH active_trades AS (
    SELECT trade.* FROM public.trades trade
    WHERE trade.league_id = p_league_id AND trade.league_season_id = p_league_season_id
      AND trade.status IN ('pending', 'accepted')
  ), trade_assets AS (
    SELECT CASE WHEN item.player_id IS NOT NULL THEN 'player' ELSE 'pick' END AS kind,
      COALESCE(item.player_id, item.pick_id) AS id, trade.id AS trade_id, trade.status
    FROM active_trades trade JOIN public.trade_items item ON item.trade_id = trade.id
    WHERE item.from_member_id = p_member_id AND COALESCE(item.player_id, item.pick_id) IS NOT NULL
      AND (item.player_id IS NOT NULL OR trade.status = 'accepted')
    UNION
    SELECT 'player', reserved.id, trade.id, trade.status
    FROM active_trades trade JOIN public.trade_participants participant ON participant.trade_id = trade.id
    CROSS JOIN LATERAL (
      SELECT unnest(participant.drop_player_ids) AS id
      UNION SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(participant.roster_moves) move
    ) reserved
    WHERE participant.member_id = p_member_id
  )
  SELECT kind, id, 'trade', trade_id,
    format('Locked by trade %s. %s', left(trade_id::text, 8),
      CASE WHEN status = 'pending' THEN 'Cancel the trade to change this asset.' ELSE 'Resolve the trade to change this asset.' END)
  FROM trade_assets
  UNION ALL
  SELECT 'player', reserved.id, 'claim', claim.id,
    format('Locked by waiver claim %s. Cancel the claim to change this player.', left(claim.id::text, 8))
  FROM public.waiver_claims claim
  CROSS JOIN LATERAL (SELECT DISTINCT unnest(ARRAY[claim.player_id, claim.drop_player_id]) AS id) reserved
  WHERE claim.league_id = p_league_id AND claim.league_season_id = p_league_season_id
    AND claim.member_id = p_member_id AND claim.status = 'pending' AND reserved.id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION private.create_multi_team_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_league leagues%ROWTYPE;
  v_rows int;
  v_participant_count int;
  v_first_recipient_member_id uuid;
  v_champion_finalized boolean := false;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Multi-team trade items must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'A multi-team trade must include between 1 and 100 items.'
      USING ERRCODE = '22023';
  END IF;

  IF octet_length(COALESCE(p_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Trade notes must not exceed 2000 bytes.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids);
  IF v_participant_count < 3 THEN
    RAISE EXCEPTION 'A multi-team trade requires at least 3 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF v_participant_count > 12 THEN
    RAISE EXCEPTION 'A multi-team trade cannot include more than 12 teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE from_member_id = to_member_id
        OR faab_amount < 0
        OR ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) <> 1
  ) THEN
    RAISE EXCEPTION 'Each multi-team trade item must route exactly one player, pick, or positive FAAB amount between two different teams.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.parse_multi_team_trade_items(p_items) AS item
     WHERE NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.from_member_id
     )
        OR NOT EXISTS (
       SELECT 1 FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant WHERE participant.member_id = item.to_member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every item source and destination must be a trade participant.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
     WHERE NOT EXISTS (
       SELECT 1
         FROM private.parse_multi_team_trade_items(p_items) AS item
        WHERE item.from_member_id = participant.member_id
           OR item.to_member_id = participant.member_id
     )
  ) THEN
    RAISE EXCEPTION 'Every participating team must send or receive at least one asset.'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) <>
     (SELECT count(DISTINCT player_id) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded players are not allowed.';
  END IF;

  IF (SELECT count(pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) <>
     (SELECT count(DISTINCT pick_id) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Duplicate traded picks are not allowed.';
  END IF;

  PERFORM private.lock_trade_offer_assets(
    p_league_id,
    ARRAY(SELECT member_id FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)),
    ARRAY(SELECT player_id FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL)
  );

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  PERFORM private.assert_trade_window(p_league_id, ARRAY(SELECT pick_id FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL));

  IF v_league.status NOT IN (
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM private.parse_multi_team_trade_items(p_items) WHERE faab_amount > 0)
     AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;


  SELECT count(*)
    INTO v_rows
    FROM league_members AS member
    JOIN private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids) AS participant
      ON participant.member_id = member.id
   WHERE member.league_id = p_league_id;

  IF v_rows <> v_participant_count THEN
    RAISE EXCEPTION 'Every trade participant must be a member of this league.';
  END IF;

  WITH locked AS (
    SELECT item.player_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN roster_players AS roster
        ON roster.league_id = p_league_id
       AND roster.league_season_id = p_league_season_id
       AND roster.member_id = item.from_member_id
       AND roster.player_id = item.player_id
       AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
     WHERE item.player_id IS NOT NULL
     FOR SHARE OF roster
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A player asset is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT item.pick_id
      FROM private.parse_multi_team_trade_items(p_items) AS item
      JOIN draft_picks AS pick
        ON pick.id = item.pick_id
       AND pick.league_id = p_league_id
       AND pick.current_owner_id = item.from_member_id
       AND pick.is_used = false
     WHERE item.pick_id IS NOT NULL
     FOR SHARE OF pick
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> (SELECT count(*) FROM private.parse_multi_team_trade_items(p_items) WHERE pick_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A draft pick asset is no longer owned by the expected team.';
  END IF;

  SELECT member_id
    INTO v_first_recipient_member_id
    FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
   WHERE member_id <> p_proposer_member_id
   ORDER BY sort_order, member_id
   LIMIT 1;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    is_multi_team,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    true,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    p_version
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_participants (
    trade_id,
    member_id,
    sort_order,
    is_initiator,
    accepted_at
  )
  SELECT
    v_trade_id,
    member_id,
    sort_order,
    member_id = p_proposer_member_id,
    CASE WHEN member_id = p_proposer_member_id THEN now() ELSE NULL END
  FROM private.multi_team_trade_participants(p_proposer_member_id, p_participant_member_ids)
  ORDER BY sort_order, member_id;

  INSERT INTO trade_items (
    trade_id,
    side,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  )
  SELECT
    v_trade_id,
    CASE WHEN from_member_id = p_proposer_member_id THEN 'proposer'::trade_side ELSE 'recipient'::trade_side END,
    player_id,
    pick_id,
    from_member_id,
    to_member_id,
    faab_amount
  FROM private.parse_multi_team_trade_items(p_items)
  ORDER BY sort_order;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    'trade_offered',
    'Multi-team trade offer sent',
    NULL,
    p_proposer_member_id,
    v_first_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'participant_count', v_participant_count,
      'item_count', jsonb_array_length(p_items)
    )
  );

  RETURN v_trade_id;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PT001';
END;
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
DECLARE lock_reason text;
BEGIN
  SELECT locked.reason INTO lock_reason FROM private.locked_assets(p_league_id,
    COALESCE(p_league_season_id, (SELECT id FROM public.league_seasons WHERE league_id=p_league_id AND is_current)), p_member_id) locked
    JOIN public.trades reservation ON reservation.id=locked.source_id AND reservation.status='accepted'
    WHERE locked.source_kind='trade' AND (p_exclude_trade_id IS NULL OR locked.source_id<>p_exclude_trade_id)
      AND ((locked.asset_kind='player' AND locked.asset_id=p_player_id) OR (locked.asset_kind='pick' AND locked.asset_id=p_pick_id))
    ORDER BY locked.source_id LIMIT 1;
  IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE = 'PA004'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_trade_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_player uuid; v_ids uuid[]; v_member uuid; lock_reason text;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=NEW.trade_id;
  IF TG_TABLE_NAME='trade_items' THEN
    v_ids := ARRAY[NEW.player_id];
    v_member := NEW.from_member_id;
  ELSE
    v_ids := NEW.drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(NEW.roster_moves) move);
    v_member := NEW.member_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member::text));
  IF v_trade.status IN ('pending','accepted') THEN
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(v_trade.league_id,v_trade.league_season_id,v_member) locked
      WHERE (locked.source_kind<>'trade' OR locked.source_id<>NEW.trade_id)
        AND NOT (locked.source_kind='trade' AND locked.source_id IN (v_trade.edited_from_trade_id,v_trade.countered_from_trade_id)
          AND EXISTS (SELECT 1 FROM trades source WHERE source.id=locked.source_id AND source.status='pending'
            AND source.league_id=v_trade.league_id AND source.league_season_id=v_trade.league_season_id
            AND ((source.id=v_trade.edited_from_trade_id AND source.proposer_member_id=v_trade.proposer_member_id
                AND source.recipient_member_id=v_trade.recipient_member_id)
              OR (source.id=v_trade.countered_from_trade_id AND source.recipient_member_id=v_trade.proposer_member_id
                AND source.proposer_member_id=v_trade.recipient_member_id))))
        AND (TG_TABLE_NAME<>'trade_items' OR locked.source_kind<>'trade'
          OR EXISTS (SELECT 1 FROM trades reservation WHERE reservation.id=locked.source_id AND reservation.status='accepted'))
        AND ((locked.asset_kind='player' AND locked.asset_id=ANY(v_ids))
          OR (TG_TABLE_NAME='trade_items' AND locked.asset_kind='pick' AND locked.asset_id=(to_jsonb(NEW)->>'pick_id')::uuid))
      ORDER BY locked.source_kind,locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END IF;
  FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
        AND trade.status='accepted' AND trade.id<>NEW.trade_id
        AND (v_player=ANY(participant.drop_player_ids) OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',v_player::text)))) THEN
      RAISE EXCEPTION 'Player is reserved by another trade roster plan.' USING ERRCODE='PT001';
    END IF;
    IF TG_TABLE_NAME='trade_participants' THEN
      IF EXISTS (SELECT 1 FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id AND item.player_id=v_player)
        OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id
          AND status='pending' AND (drop_player_id=v_player OR player_id=v_player)) THEN
        RAISE EXCEPTION 'Planned drop or move is reserved by another trade or active waiver claim.' USING ERRCODE='PT001';
      END IF;
    END IF;
  END LOOP;
  IF TG_TABLE_NAME='trade_items' THEN
  IF NEW.player_id IS NOT NULL AND v_trade.status='pending'
    AND EXISTS (SELECT 1 FROM leagues WHERE id=v_trade.league_id AND allow_inactive_trades)
    AND EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=NEW.from_member_id AND player_id=NEW.player_id AND is_on_taxi) THEN
    NEW.to_taxi := true;
  END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_completing_trade_id uuid;
  v_applied_trade_id text:=current_setting('pancake.applied_trade_id',true);
  lock_reason text;
BEGIN
  IF OLD.member_id<>NEW.member_id THEN
    SELECT c.related_id INTO v_completing_trade_id FROM private.taxi_acquisition_context c
    JOIN trades t ON t.id=c.related_id AND t.status='accepted' AND t.id::text=v_applied_trade_id
    JOIN trade_items i ON i.trade_id=t.id AND i.player_id=NEW.player_id
      AND i.from_member_id=OLD.member_id AND i.to_member_id=NEW.member_id
      AND i.to_ir=NEW.is_on_ir AND (i.to_taxi OR OLD.is_on_taxi)=NEW.is_on_taxi
    WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade'
      AND c.league_id=NEW.league_id AND c.league_season_id=NEW.league_season_id
      AND c.member_id=NEW.member_id AND c.player_id=NEW.player_id
      AND t.league_id=NEW.league_id AND t.league_season_id=NEW.league_season_id;
  END IF;
  IF OLD.member_id=NEW.member_id THEN
    SELECT trade.id INTO v_completing_trade_id FROM private.taxi_acquisition_context context
    JOIN trades trade ON trade.id=context.related_id JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE context.transaction_id=pg_current_xact_id() AND context.source='trade'
      AND context.league_id=OLD.league_id AND context.league_season_id=OLD.league_season_id
      AND context.member_id=OLD.member_id AND context.player_id=OLD.player_id
      AND trade.status='accepted' AND trade.id::text=v_applied_trade_id
      AND trade.league_id=OLD.league_id AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id
      AND NOT (NEW.is_on_ir AND NEW.is_on_taxi)
      AND participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',OLD.player_id::text,
        'destination',CASE WHEN NEW.is_on_taxi THEN 'taxi' WHEN NEW.is_on_ir THEN 'ir' ELSE 'active' END));
  END IF;
  IF (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, v_completing_trade_id);
  END IF;

  IF (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    SELECT locked.reason INTO lock_reason FROM private.locked_assets(OLD.league_id, OLD.league_season_id, OLD.member_id) locked
      WHERE locked.source_kind='claim' AND locked.asset_id=OLD.player_id ORDER BY locked.source_id LIMIT 1;
    IF lock_reason IS NOT NULL THEN RAISE EXCEPTION '%', lock_reason USING ERRCODE='PA004'; END IF;
  END IF;

  IF v_completing_trade_id IS NULL AND (
    (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id) IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id)
    OR OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi) THEN
    PERFORM private.assert_asset_unlocked(OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id);
  END IF;

  IF OLD.member_id IS DISTINCT FROM NEW.member_id AND v_completing_trade_id IS NULL AND (
    ((OLD.is_on_ir OR OLD.is_on_taxi OR NEW.is_on_ir) AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades)) OR
    (NEW.is_on_taxi = true AND v_completing_trade_id IS NULL AND NOT EXISTS (SELECT 1 FROM leagues WHERE id=NEW.league_id AND allow_inactive_trades))
  ) THEN
    RAISE EXCEPTION 'Inactive roster players must be activated before they can be traded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_trade_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type text;
  v_title text;
  v_body text;
  v_single_recipient uuid;
  v_all_participants boolean := false;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
    v_all_participants := true;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'rejected'::public.trade_status THEN
    v_event_type := 'trade_rejected';
    v_title := 'Trade Rejected';
    v_body := 'Your trade offer was declined.';
    v_single_recipient := NEW.proposer_member_id;
    v_all_participants := COALESCE(NEW.is_multi_team, false);
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'withdrawn'::public.trade_status THEN
    v_event_type := 'trade_withdrawn';
    v_title := 'Trade Withdrawn';
    IF NEW.completion_failure_reason IN ('A player in this offer was traded','An asset in this offer was traded') THEN
      v_title := 'Trade Cancelled';
      v_body := NEW.completion_failure_reason;
      v_all_participants := true;
    ELSE
      v_body := 'A trade offer sent to you has been withdrawn.';
      v_all_participants := COALESCE(NEW.is_multi_team, false);
    END IF;
    v_single_recipient := NEW.recipient_member_id;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
    v_all_participants := true;
  ELSIF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'vetoed'::public.trade_status THEN
    v_event_type := 'trade_vetoed';
    v_title := 'Trade Vetoed';
    v_body := 'An accepted trade was vetoed before completion.';
    v_all_participants := true;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('%s:%s:%s', v_event_type, NEW.id, recipient.member_id),
    recipient.member_id,
    v_event_type,
    v_title,
    v_body,
    jsonb_build_object('tradeId', NEW.id, 'leagueId', NEW.league_id),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.id
       AND v_all_participants
       AND (v_event_type <> 'trade_withdrawn' OR participant.member_id <> NEW.proposer_member_id
         OR NEW.completion_failure_reason IN ('A player in this offer was traded','An asset in this offer was traded'))
       AND (v_event_type <> 'trade_rejected' OR participant.member_id = NEW.proposer_member_id OR participant.accepted_at IS NOT NULL)
    UNION SELECT v_single_recipient WHERE NOT v_all_participants
  ) AS recipient
  WHERE recipient.member_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.league_members member WHERE member.id = recipient.member_id AND member.league_id = NEW.league_id)
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.check_trade_legality(
  p_league_id uuid,p_season_id uuid,p_member_ids uuid[],p_items jsonb,p_plans jsonb,p_trade_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_league leagues%ROWTYPE; v_team record; v_row record; v_item record; v_move jsonb;
  v_plan jsonb; v_roster jsonb; v_drops jsonb; v_reasons jsonb; v_suggestions jsonb; v_teams jsonb:='[]';
  v_unavailable jsonb; v_destinations jsonb; v_ir_error text; v_taxi_error text; v_error text;
  v_active int; v_ir int; v_taxi int; v_total int; v_limit int; v_count int; v_excess int;
  v_year int; v_available int; v_cost int; v_location text; v_rule text; v_name text; v_ir_out text; v_fix text;
BEGIN
  SELECT * INTO STRICT v_league FROM leagues WHERE id=p_league_id;
  SELECT season_year INTO STRICT v_year FROM league_seasons WHERE id=p_season_id AND league_id=p_league_id;
  FOR v_team IN SELECT id,team_name FROM league_members WHERE league_id=p_league_id AND id=ANY(p_member_ids) ORDER BY array_position(p_member_ids,id)
  LOOP
    v_plan:=COALESCE(p_plans->v_team.id::text,'{}'); v_reasons:='[]'; v_unavailable:='{}'; v_destinations:='{}';
    WITH items AS (SELECT * FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)),
    retained AS (
      SELECT r.player_id,COALESCE(m.value->>'destination',CASE WHEN r.is_on_taxi THEN 'taxi' WHEN r.is_on_ir THEN 'ir' ELSE 'active' END) location,false incoming
      FROM roster_players r LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) WHERE value->>'playerId'=r.player_id::text) m ON true
      WHERE r.league_season_id=p_season_id AND r.member_id=v_team.id
        AND NOT COALESCE(v_plan->'dropPlayerIds','[]') ? r.player_id::text
        AND NOT EXISTS(SELECT 1 FROM items WHERE "fromMemberId"=v_team.id AND "playerId"=r.player_id)
      UNION ALL
      SELECT i."playerId",CASE WHEN r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text THEN 'taxi'
        WHEN COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text THEN 'ir' ELSE 'active' END,true
      FROM items i JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id
    ) SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name,'location',r.location,'incoming',r.incoming) ORDER BY p.display_name),'[]') INTO v_roster
      FROM retained r JOIN players p ON p.id=r.player_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',p.id,'name',p.display_name)),'[]') INTO v_drops
      FROM players p WHERE COALESCE(v_plan->'dropPlayerIds','[]') ? p.id::text;
    FOR v_row IN
      SELECT DISTINCT p.id,p.display_name,p.injury_status FROM players p WHERE p.id IN
        (SELECT (value->>'playerId')::uuid FROM jsonb_array_elements(v_roster)
         UNION SELECT player_id FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id) ORDER BY p.id
    LOOP
      v_error:=NULL;
      IF EXISTS(SELECT 1 FROM private.locked_assets(p_league_id,p_season_id,v_team.id) locked
        WHERE locked.source_kind='trade' AND locked.asset_id=v_row.id AND locked.source_id IS DISTINCT FROM p_trade_id) THEN v_error:='Reserved by another trade.';
      ELSIF EXISTS(SELECT 1 FROM waiver_claims WHERE league_season_id=p_season_id AND member_id=v_team.id AND status='pending' AND drop_player_id=v_row.id) THEN v_error:='Reserved as a pending waiver drop.'; END IF;
      IF v_error IS NOT NULL THEN v_unavailable:=v_unavailable||jsonb_build_object(v_row.id,v_error); END IF;
      v_ir_error:=CASE WHEN v_league.ir_slots=0 THEN 'This league has no IR slots.' WHEN NOT private.is_ir_designation(v_row.injury_status) THEN 'IR requires an Out or IR designation.' END;
      v_taxi_error:=CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid)
          WHERE i."playerId"=v_row.id AND i."toMemberId"=v_team.id)
          AND NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=v_row.id AND is_on_taxi)
          THEN 'Only incoming players can be placed on Taxi.'
        WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
        WHEN EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=v_team.id AND player_id=v_row.id) THEN 'This player cannot return to this team taxi squad.'
        WHEN NOT private.taxi_player_eligible(p_league_id,v_row.id) THEN 'Taxi requires a rookie or fewer than 65 known career games.'
        WHEN v_league.taxi_max_seasons IS NOT NULL AND v_year-private.taxi_start_year(p_league_id,v_row.id,v_year)>=v_league.taxi_max_seasons THEN 'This player has reached the taxi tenure limit.' END;
      v_destinations:=v_destinations||jsonb_build_object(v_row.id,jsonb_strip_nulls(jsonb_build_object('ir',v_ir_error,'taxi',v_taxi_error)));
      SELECT value->>'location' INTO v_location FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text;
      v_rule:=CASE WHEN v_location='ir' AND v_ir_error IS NOT NULL THEN 'ir_eligibility' WHEN v_location='taxi' AND v_taxi_error IS NOT NULL THEN 'taxi_eligibility' END;
      IF v_rule IS NOT NULL THEN
        v_error:=format('%s: %s cannot use %s. %s Move %s to Regular or choose a drop.',v_team.team_name,v_row.display_name,upper(v_location),CASE WHEN v_location='ir' THEN v_ir_error ELSE v_taxi_error END,v_row.display_name);
        v_suggestions:=jsonb_build_array(jsonb_build_object('action','move','playerId',v_row.id,'playerName',v_row.display_name,'destination','active','message',format('Move %s to Regular.',v_row.display_name)));
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_roster) WHERE value->>'playerId'=v_row.id::text AND (value->>'incoming')::boolean) THEN
          v_suggestions:=v_suggestions||jsonb_build_array(jsonb_build_object('action','drop','playerId',v_row.id,'playerName',v_row.display_name,'message',format('Drop %s.',v_row.display_name)));
        END IF;
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_row.id,'message',v_error,'suggestedMoves',v_suggestions));
      END IF;
    END LOOP;
    FOR v_item IN SELECT i.*,p.display_name,r.is_on_ir,r.is_on_taxi FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN players p ON p.id=i."playerId" LEFT JOIN roster_players r ON r.league_season_id=p_season_id AND r.member_id=i."fromMemberId" AND r.player_id=i."playerId"
      WHERE i."fromMemberId"=v_team.id ORDER BY i."playerId"
    LOOP
      v_rule:=NULL; v_error:=NULL;
      IF v_item.is_on_ir IS NULL THEN v_rule:='ownership'; v_error:=format('%s no longer owns %s. Remove this player from the trade.',v_team.team_name,v_item.display_name);
      ELSIF NOT v_league.allow_inactive_trades AND (v_item.is_on_ir OR v_item.is_on_taxi) THEN
        v_rule:=CASE WHEN v_item.is_on_ir THEN 'ir_trade_eligibility' ELSE 'taxi_trade_eligibility' END;
        v_error:=format('%s: the %s trade rule blocks %s. Move %s to Regular before offering this trade.',v_team.team_name,CASE WHEN v_item.is_on_ir THEN 'IR' ELSE 'taxi' END,v_item.display_name,v_item.display_name);
      END IF;
      IF v_rule IS NOT NULL THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'playerId',v_item."playerId",'message',v_error,
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','move_before_trade','playerId',v_item."playerId",'destination','active','message',format('Move %s to Regular before offering.',v_item.display_name))))); END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"toMemberId" uuid,"toIR" boolean,"toTaxi" boolean)
      JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i."playerId"
      WHERE i."toMemberId"=v_team.id AND (COALESCE(i."toIR",false) OR COALESCE(v_plan->'irPlayerIds','[]') ? i."playerId"::text)
        AND (r.is_on_taxi OR COALESCE(i."toTaxi",false) OR COALESCE(v_plan->'taxiPlayerIds','[]') ? i."playerId"::text)) THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','destination_slot',
        'message',format('%s: an incoming player cannot use both IR and taxi. Traded taxi players stay on taxi.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_destination','destination','taxi','message','Keep the taxi destination and remove the IR choice.'))));
    END IF;
    FOR v_move IN SELECT value FROM jsonb_array_elements(COALESCE(v_plan->'rosterMoves','[]')) UNION ALL
      SELECT jsonb_build_object('playerId',value,'destination','drop') FROM jsonb_array_elements_text(COALESCE(v_plan->'dropPlayerIds','[]'))
    LOOP
      IF v_move->>'destination'='taxi' THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','taxi_incoming_only','playerId',v_move->>'playerId',
          'message','Only incoming players can be placed on Taxi.','suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
      IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND member_id=v_team.id AND player_id=(v_move->>'playerId')::uuid)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) WHERE value->>'playerId'=v_move->>'playerId') OR v_unavailable ? (v_move->>'playerId') THEN
        v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','planned_move','playerId',v_move->>'playerId',
          'message',format('%s: a planned move uses a missing, offered, or reserved player. Choose another player.',v_team.team_name),'suggestedMoves',jsonb_build_array(jsonb_build_object('action','remove_move','playerId',v_move->>'playerId','message','Remove this planned move.'))));
      END IF;
    END LOOP;
    SELECT count(*),count(*) FILTER(WHERE value->>'location'='active'),count(*) FILTER(WHERE value->>'location'='ir'),count(*) FILTER(WHERE value->>'location'='taxi')
      INTO v_total,v_active,v_ir,v_taxi FROM jsonb_array_elements(v_roster);
    SELECT string_agg(p.display_name,', ') INTO v_ir_out FROM jsonb_to_recordset(p_items) AS i("playerId" uuid,"fromMemberId" uuid)
      JOIN roster_players r ON r.player_id=i."playerId" AND r.league_season_id=p_season_id AND r.member_id=v_team.id AND r.is_on_ir
      JOIN players p ON p.id=r.player_id WHERE i."fromMemberId"=v_team.id;
    FOR v_location,v_count,v_limit,v_rule,v_name IN SELECT * FROM (VALUES
      ('total',v_total,v_league.roster_size+v_league.ir_slots+v_league.taxi_slots,'roster_size','total roster'),
      ('active',v_active,v_league.roster_size,'active_slots','Regular roster'),('ir',v_ir,v_league.ir_slots,'ir_limit','IR'),('taxi',v_taxi,v_league.taxi_slots,'taxi_limit','taxi')) rules
    LOOP
      v_excess:=v_count-v_limit;
      IF v_excess<=0 THEN CONTINUE; END IF;
      v_suggestions:='[]';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('action','drop','playerId',value->>'playerId','playerName',value->>'name','count',v_excess,
        'message',format('Drop %s.',value->>'name'))),'[]') INTO v_suggestions FROM jsonb_array_elements(v_roster)
        WHERE NOT (value->>'incoming')::boolean AND NOT v_unavailable ? (value->>'playerId') AND (v_location='total' OR value->>'location'=v_location);
      IF v_location<>'total' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','move','playerId',r.value->>'playerId','playerName',r.value->>'name','destination',d.location,
          'message',format('Move %s to %s.',r.value->>'name',CASE WHEN d.location='active' THEN 'Regular' ELSE upper(d.location) END))),'[]')||v_suggestions INTO v_suggestions
        FROM jsonb_array_elements(v_roster) r CROSS JOIN (VALUES('active',v_league.roster_size-v_active),('ir',v_league.ir_slots-v_ir),('taxi',v_league.taxi_slots-v_taxi)) d(location,free)
        WHERE r.value->>'location'=v_location AND d.location<>v_location AND d.free>0 AND NOT v_unavailable ? (r.value->>'playerId')
          AND NOT COALESCE(v_destinations->(r.value->>'playerId'),'{}') ? d.location
          AND NOT (d.location<>'taxi' AND EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=p_season_id AND player_id=(r.value->>'playerId')::uuid AND is_on_taxi) AND (r.value->>'incoming')::boolean);
      END IF;
      IF jsonb_array_length(v_suggestions)=0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('action','remove_incoming','playerId',value->>'playerId','count',v_excess,
          'message',format('Remove %s from the trade.',value->>'name'))),'[]') INTO v_suggestions
          FROM jsonb_array_elements(v_roster) WHERE (value->>'incoming')::boolean AND (v_location='total' OR value->>'location'=v_location);
      END IF;
      v_error:=format('%s: %s is %s over the limit of %s. Drop %s %s or change the listed placements.',v_team.team_name,v_name,v_excess,v_limit,v_excess,CASE WHEN v_excess=1 THEN 'player' ELSE 'players' END);
      SELECT rtrim(value->>'message','.') INTO v_fix FROM jsonb_array_elements(v_suggestions) WHERE value->>'action'='move' LIMIT 1;
      IF v_excess=1 AND v_fix IS NOT NULL THEN
        v_error:=format('%s: %s is 1 over the limit of %s. Drop 1 player or %s.',v_team.team_name,v_name,v_limit,lower(left(v_fix,1))||substr(v_fix,2));
      END IF;
      IF v_location='active' AND v_ir_out IS NOT NULL THEN v_error:=v_error||format(' Trading %s from IR does not free a Regular slot.',v_ir_out); END IF;
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule',v_rule,'count',v_excess,'limit',v_limit,'message',v_error,'suggestedMoves',v_suggestions));
    END LOOP;
    IF EXISTS(SELECT 1 FROM trades WHERE id=p_trade_id AND status='accepted') THEN
    SELECT COALESCE(sum((value->>'faabAmount')::int),0) INTO v_cost FROM jsonb_array_elements(p_items) WHERE value->>'fromMemberId'=v_team.id::text;
    v_available:=private.read_available_faab_balance(p_league_id,p_season_id,v_team.id,p_trade_id);
    IF v_cost>v_available THEN v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','budget','count',v_cost-v_available,
      'message',format('%s: the budget is short by %s FAAB. Reduce the offered FAAB by %s.',v_team.team_name,v_cost-v_available,v_cost-v_available),
      'suggestedMoves',jsonb_build_array(jsonb_build_object('action','reduce_faab','amount',v_cost-v_available,'message',format('Reduce offered FAAB by %s.',v_cost-v_available))))); END IF;
    END IF;
    IF EXISTS(
      WITH commitments AS (
        SELECT t.id,p.drop_player_ids,p.roster_moves FROM trades t JOIN trade_participants p ON p.trade_id=t.id
        WHERE t.league_season_id=p_season_id AND p.member_id=v_team.id AND t.status='accepted' AND t.id IS DISTINCT FROM p_trade_id
      ), resulting AS (
        SELECT COALESCE(m.value->>'destination',r.value->>'location') location
        FROM jsonb_array_elements(v_roster) r LEFT JOIN LATERAL (
          SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=r.value->>'playerId'
        ) m ON true
        WHERE NOT EXISTS(SELECT 1 FROM commitments WHERE (r.value->>'playerId')::uuid=ANY(drop_player_ids))
          AND NOT EXISTS(SELECT 1 FROM commitments c JOIN trade_items i ON i.trade_id=c.id WHERE i.from_member_id=v_team.id AND i.player_id=(r.value->>'playerId')::uuid)
        UNION ALL
        SELECT CASE WHEN i.to_taxi OR r.is_on_taxi THEN 'taxi' WHEN i.to_ir THEN 'ir' ELSE 'active' END
        FROM commitments c JOIN trade_items i ON i.trade_id=c.id AND i.to_member_id=v_team.id
        JOIN roster_players r ON r.league_season_id=p_season_id AND r.player_id=i.player_id
      ) SELECT 1 FROM resulting HAVING count(*) FILTER(WHERE location='active')>v_league.roster_size
        OR count(*) FILTER(WHERE location='ir')>v_league.ir_slots OR count(*) FILTER(WHERE location='taxi')>v_league.taxi_slots
    ) AND jsonb_array_length(v_reasons)=0 THEN
      v_reasons:=v_reasons||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'rule','reserved_capacity',
        'message',format('%s: accepted trades reserve these roster slots. Add a drop or choose an eligible open slot.',v_team.team_name),
        'suggestedMoves',jsonb_build_array(jsonb_build_object('action','change_plan','message','Add a drop or resolve another accepted trade.'))));
    END IF;
    SELECT string_agg(value->>'message',' ') INTO v_error FROM jsonb_array_elements(v_reasons);
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object('memberId',v_team.id,'teamName',v_team.team_name,'roster',v_roster,'drops',v_drops,'moves',COALESCE(v_plan->'rosterMoves','[]'),
      'plan',v_plan,'limits',jsonb_build_object('active',v_league.roster_size,'ir',v_league.ir_slots,'taxi',v_league.taxi_slots),'reasons',v_reasons,'legal',jsonb_array_length(v_reasons)=0,
      'error',v_error,'unavailableMoves',v_unavailable,'unavailableDestinations',v_destinations));
  END LOOP;
  RETURN v_teams;
END;
$$;

CREATE OR REPLACE FUNCTION private.cancel_pending_trades_for_moved_assets(p_trade_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_other record; v_previous_flag text;
BEGIN
  v_previous_flag := private.begin_trade_lifecycle_write();
  FOR v_other IN
    SELECT other.id, bool_or(moved.pick_id IS NOT NULL) AS non_player
    FROM public.trades source JOIN public.trade_items moved ON moved.trade_id=source.id
    JOIN public.trades other ON other.league_id=source.league_id
      AND other.league_season_id=source.league_season_id AND other.id<>source.id AND other.status='pending'
    WHERE source.id=p_trade_id AND source.status IN ('accepted','completed')
      AND (EXISTS(SELECT 1 FROM public.trade_items item WHERE item.trade_id=other.id
        AND (item.player_id=moved.player_id OR item.pick_id=moved.pick_id))
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=other.id
          AND (moved.player_id=ANY(participant.drop_player_ids)
            OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',moved.player_id::text)))))
    GROUP BY other.id ORDER BY other.id
  LOOP
    UPDATE public.trades SET status='withdrawn',completion_failure_reason=CASE
      WHEN v_other.non_player THEN 'An asset in this offer was traded' ELSE 'A player in this offer was traded' END
    WHERE id=v_other.id AND status='pending';
  END LOOP;
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
END;
$$;
REVOKE ALL ON FUNCTION private.cancel_pending_trades_for_moved_assets(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.cancel_conflicting_trade_offers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IN ('accepted','completed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM private.cancel_pending_trades_for_moved_assets(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.cancel_conflicting_trade_offers() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS cancel_conflicting_trade_offers ON public.trades;
CREATE TRIGGER cancel_conflicting_trade_offers AFTER UPDATE OF status ON public.trades
FOR EACH ROW EXECUTE FUNCTION private.cancel_conflicting_trade_offers();

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
  v_deadline boolean;
  v_member record;
  v_roster record;
  v_active int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
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

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status NOT IN ('completed'::draft_status,'cancelled'::draft_status) THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 AND v_draft.status<>'cancelled' THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  v_deadline := COALESCE(private.draft_timer_opening_night_cutoff(v_current_season.season_year) <= now(), false);
  IF v_league.status = 'drafting' AND v_deadline THEN
    FOR v_member IN SELECT id FROM league_members WHERE league_id = v_draft.league_id ORDER BY id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.league_id::text), hashtext(v_member.id::text)) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_active FROM roster_players
        WHERE league_season_id = v_current_season.id AND member_id = v_member.id
          AND NOT is_on_ir AND NOT is_on_taxi;
      FOR v_roster IN
        SELECT roster.id, roster.player_id FROM roster_players AS roster
          JOIN snake_draft_picks AS pick ON pick.draft_id = v_draft.id
            AND pick.member_id = roster.member_id AND pick.player_id = roster.player_id
          JOIN players AS player ON player.id = roster.player_id AND player.years_exp = 0
        WHERE roster.league_season_id = v_current_season.id AND roster.member_id = v_member.id
          AND NOT EXISTS(SELECT 1 FROM private.locked_assets(v_draft.league_id,v_current_season.id,v_member.id) locked
            WHERE locked.asset_kind='player' AND locked.asset_id=roster.player_id)
          AND roster.acquired_via = 'draft' AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        ORDER BY pick.overall_pick DESC, roster.id FOR UPDATE OF roster SKIP LOCKED
      LOOP
        EXIT WHEN v_active <= v_league.roster_size;
        IF private.can_acquire_draft_taxi(v_draft.league_id, v_current_season.id, v_member.id,
          v_roster.player_id, v_draft.id, v_roster.id) THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id, v_current_season.id,
            v_member.id, v_roster.player_id, 'draft', v_draft.id);
          UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster.id;
          INSERT INTO roster_transactions(league_id, league_season_id, member_id, player_id, transaction_type)
          VALUES(v_draft.league_id, v_current_season.id, v_member.id, v_roster.player_id, 'taxi_designate');
          v_active := v_active - 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND AND NOT v_deadline THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
  v_previous_applied_trade text;
  v_drop record;
  v_move record;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
      UNION SELECT (move->>'playerId')::uuid FROM trade_participants,jsonb_array_elements(roster_moves) move WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    WHERE participant.trade_id=p_trade_id AND move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;

  BEGIN
    PERFORM private.validate_trade_rosters(p_trade_id);
  EXCEPTION WHEN SQLSTATE 'PT001' OR SQLSTATE 'PT409' THEN
    PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    RETURN;
  END;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false))
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

    END IF;
  END LOOP;

  PERFORM private.cancel_pending_trades_for_moved_assets(p_trade_id);

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  -- A reserved pick may only change hands through this completion; the
  -- draft_picks guard and the trade status guard honour this mark.
  v_previous_flag := private.begin_trade_lifecycle_write();
  v_previous_applied_trade:=COALESCE(current_setting('pancake.applied_trade_id',true),'');
  PERFORM set_config('pancake.applied_trade_id',p_trade_id::text,true);
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  FOR v_move IN SELECT roster.id,roster.member_id,roster.player_id,roster.is_on_ir,roster.is_on_taxi,move->>'destination' AS destination
    FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    JOIN roster_players roster ON roster.player_id=(move->>'playerId')::uuid AND roster.member_id=participant.member_id
      AND roster.league_season_id=v_trade.league_season_id
    WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
  LOOP
    IF private.roster_status_game_started(v_move.player_id) THEN
      RAISE EXCEPTION 'A planned roster move waits for the player game slate to end.' USING ERRCODE='PT002';
    END IF;
    PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,'trade',p_trade_id);
    UPDATE roster_players SET is_on_ir=v_move.destination='ir',is_on_taxi=v_move.destination='taxi',
      taxi_start_season_year=CASE WHEN v_move.destination='taxi' THEN private.taxi_start_year(v_trade.league_id,v_move.player_id,(SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id)) ELSE taxi_start_season_year END WHERE id=v_move.id;
    INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
      VALUES(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,
        CASE WHEN v_move.destination='taxi' THEN 'taxi_designate' WHEN v_move.destination='ir' THEN 'ir_designate' WHEN v_move.is_on_taxi THEN 'taxi_return' ELSE 'ir_return' END,p_trade_id);
  END LOOP;

  WITH changed_claims AS (
    UPDATE waiver_claims AS claim
       SET status = 'cancelled',
           failure_reason = 'The selected drop player left this roster in another transaction.',
           processed_at = now(),
           drop_player_id = NULL
     WHERE claim.status = 'pending'
       AND claim.league_id = v_trade.league_id
       AND claim.league_season_id = v_trade.league_season_id
       AND EXISTS (
         SELECT 1 FROM trade_items AS item
          WHERE item.trade_id = p_trade_id
            AND item.from_member_id = claim.member_id
            AND item.player_id = claim.drop_player_id
            AND (v_league.allow_inactive_trades OR item.to_taxi OR item.to_ir)
       )
     RETURNING claim.id, claim.member_id, claim.failure_reason
  )
  INSERT INTO notification_outbox(dedupe_key, member_id, event_type, title, body, data, category)
  SELECT 'trade_claim_cancelled:' || id, member_id, 'trade_claim_cancelled', 'Waiver claim cancelled',
    failure_reason, jsonb_build_object('claimId', id), 'trade'
  FROM changed_claims
  ON CONFLICT (dedupe_key) DO NOTHING;

  UPDATE waiver_claims AS claim
     SET drop_player_id = NULL
   WHERE claim.status = 'pending'
     AND claim.league_id = v_trade.league_id
     AND claim.league_season_id = v_trade.league_season_id
     AND EXISTS (
       SELECT 1 FROM trade_items AS item
        WHERE item.trade_id = p_trade_id
          AND item.from_member_id = claim.member_id
          AND item.player_id = claim.drop_player_id
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      BEGIN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade',
             is_on_taxi = v_item.to_taxi OR (v_league.allow_inactive_trades AND is_on_taxi),
             is_on_ir = CASE WHEN v_league.allow_inactive_trades THEN v_item.to_ir ELSE is_on_ir END
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false));

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        -- A game in progress only delays a taxi destination: keep the accepted trade for a later run.
        IF v_item.to_taxi AND SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PT002';
        END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION '% acquisition failed: %',
          CASE WHEN v_item.to_taxi THEN 'Taxi' WHEN v_item.to_ir THEN 'IR' ELSE 'Player' END,
          SQLERRM USING ERRCODE='PT001';
      END;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        acquired_to_taxi,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', false, p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', v_item.to_taxi, p_trade_id);
    ELSIF v_item.pick_id IS NOT NULL THEN
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL,
         legality_issues = '[]'
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  FOR v_member_lock IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_member_lock);
  END LOOP;
  PERFORM set_config('pancake.applied_trade_id',v_previous_applied_trade,true);
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
END;
$$;
