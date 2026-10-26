ALTER TABLE public.trade_participants ADD COLUMN roster_moves jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(roster_moves)='array' AND jsonb_array_length(roster_moves)<=100);
DROP FUNCTION public.accept_trade_with_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]);
DROP FUNCTION public.set_trade_roster_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]);
CREATE OR REPLACE FUNCTION private.trade_resulting_roster(p_trade_id uuid,p_member_id uuid)
RETURNS TABLE(player_id uuid,on_ir boolean,on_taxi boolean)
LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT roster.player_id,
    CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END,
    CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE false END
  FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.member_id=p_member_id
  LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(participant.roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
  WHERE trade.id=p_trade_id AND NOT roster.player_id=ANY(participant.drop_player_ids)
    AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=trade.id AND item.from_member_id=p_member_id AND item.player_id=roster.player_id)
  UNION ALL
  SELECT item.player_id,item.to_ir,item.to_taxi OR roster.is_on_taxi
  FROM trades trade JOIN trade_items item ON item.trade_id=trade.id AND item.to_member_id=p_member_id
  JOIN roster_players roster ON roster.league_season_id=trade.league_season_id AND roster.player_id=item.player_id
  WHERE trade.id=p_trade_id
$$;

CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_counts record; v_league leagues%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND participant.member_id=p_member_id
      AND (trade.status='accepted' OR trade.id=p_include_trade_id)) THEN RETURN; END IF;
  SELECT * INTO v_league FROM leagues WHERE id=p_league_id;
  WITH commitments AS (
    SELECT trade.id,participant.drop_player_ids,participant.roster_moves
    FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id AND participant.member_id=p_member_id
    WHERE trade.league_id=p_league_id AND trade.league_season_id=p_season_id AND (trade.status='accepted' OR trade.id=p_include_trade_id)
  ), resulting AS (
    SELECT CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination'='ir' END AS on_ir,
      CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE false END AS on_taxi
    FROM roster_players roster
    LEFT JOIN LATERAL (SELECT value FROM commitments,jsonb_array_elements(roster_moves) WHERE value->>'playerId'=roster.player_id::text) move ON true
    WHERE roster.league_season_id=p_season_id AND roster.member_id=p_member_id
      AND NOT EXISTS (SELECT 1 FROM commitments WHERE roster.player_id=ANY(drop_player_ids))
      AND NOT EXISTS (SELECT 1 FROM commitments JOIN trade_items item ON item.trade_id=commitments.id
        WHERE item.from_member_id=p_member_id AND item.player_id=roster.player_id)
    UNION ALL
    SELECT item.to_ir,item.to_taxi OR roster.is_on_taxi
    FROM commitments JOIN trade_items item ON item.trade_id=commitments.id AND item.to_member_id=p_member_id
    JOIN roster_players roster ON roster.league_season_id=p_season_id AND roster.player_id=item.player_id
  ) SELECT count(*) FILTER(WHERE NOT on_ir AND NOT on_taxi) active,count(*) FILTER(WHERE on_ir) ir,
      count(*) FILTER(WHERE on_taxi) taxi INTO v_counts FROM resulting;
  IF v_counts.active>v_league.roster_size OR v_counts.ir>v_league.ir_slots OR v_counts.taxi>v_league.taxi_slots THEN
    RAISE EXCEPTION 'Accepted trades reserve roster capacity. Change this action or resolve the trade first.' USING ERRCODE='PT001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_accepted_trade_capacity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_member uuid; v_league uuid; v_season uuid;
BEGIN
  FOR v_league,v_season,v_member IN
    SELECT DISTINCT league_id,league_season_id,member_id FROM (
      SELECT OLD.league_id,OLD.league_season_id,OLD.member_id WHERE TG_OP<>'INSERT'
      UNION ALL SELECT NEW.league_id,NEW.league_season_id,NEW.member_id WHERE TG_OP<>'DELETE'
    ) affected ORDER BY league_id,member_id,league_season_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_league::text),hashtext(v_member::text));
    IF TG_WHEN='AFTER' THEN
      PERFORM private.assert_accepted_trade_capacity(v_league,v_season,v_member);
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Canonical SQL source for private.is_reserved_trade_asset.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = p_league_id
       AND (p_league_season_id IS NULL OR trade.league_season_id = p_league_season_id)
       AND (p_exclude_trade_id IS NULL OR trade.id <> p_exclude_trade_id)
       AND item.from_member_id = p_member_id
       AND (
         (p_player_id IS NOT NULL AND item.player_id = p_player_id)
         OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
       )
  ) OR EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
    WHERE trade.status IN ('pending','accepted') AND trade.league_id=p_league_id
      AND (p_league_season_id IS NULL OR trade.league_season_id=p_league_season_id)
      AND (p_exclude_trade_id IS NULL OR trade.id<>p_exclude_trade_id)
      AND participant.member_id=p_member_id AND (p_player_id=ANY(participant.drop_player_ids)
        OR participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',p_player_id::text))))
$$;

CREATE OR REPLACE FUNCTION private.guard_trade_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_player uuid; v_ids uuid[]; v_member uuid;
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
  FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
        AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id
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

-- Canonical SQL source for private.prevent_accepted_or_inactive_roster_move.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE v_completing_trade_id uuid;
BEGIN
  IF OLD.member_id<>NEW.member_id THEN
    SELECT c.related_id INTO v_completing_trade_id FROM private.taxi_acquisition_context c
    JOIN trades t ON t.id=c.related_id AND t.status='accepted'
    JOIN trade_items i ON i.trade_id=t.id AND i.player_id=NEW.player_id
      AND i.from_member_id=OLD.member_id AND i.to_member_id=NEW.member_id
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
      AND trade.status='accepted' AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id
      AND NOT NEW.is_on_taxi AND participant.roster_moves @> jsonb_build_array(jsonb_build_object('playerId',OLD.player_id::text,
        'destination',CASE WHEN NEW.is_on_ir THEN 'ir' ELSE 'active' END));
  END IF;
  IF OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, v_completing_trade_id);
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM waiver_claims AS claim
     WHERE claim.status = 'pending'::waiver_claim_status
       AND claim.league_id = OLD.league_id
       AND claim.league_season_id = OLD.league_season_id
       AND claim.member_id = OLD.member_id
       AND claim.drop_player_id = OLD.player_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as a pending waiver drop.'
      USING ERRCODE = 'P0001';
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

CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid, p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_count record;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id FOR UPDATE;
  PERFORM 1 FROM players player
    WHERE player.id IN (SELECT player_id FROM trade_items WHERE trade_id=p_trade_id
      UNION SELECT roster.player_id FROM roster_players roster JOIN trade_participants participant ON participant.member_id=roster.member_id
        WHERE participant.trade_id=p_trade_id AND roster.league_season_id=v_trade.league_season_id)
    ORDER BY player.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=item.from_member_id AND player_id=item.player_id)) THEN
    RAISE EXCEPTION 'A trade player is no longer owned by the expected team.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_ir AND
      (item.to_taxi OR NOT private.is_ir_designation(player.injury_status))) THEN
    RAISE EXCEPTION 'Incoming IR players must be Out or IR-designated and cannot also enter taxi.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id=item.player_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id)
      AND item.to_taxi AND player.career_regular_season_games IS NULL
      AND NOT private.taxi_player_eligible(v_trade.league_id,item.player_id)) THEN
    RAISE EXCEPTION 'The career games count is not known yet. This player cannot enter taxi.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
      ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
    WHERE item.trade_id = p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi
      AND NOT private.taxi_player_eligible(v_trade.league_id, item.player_id)) THEN
    RAISE EXCEPTION 'Incoming taxi players must be rookies or have fewer than 65 career regular-season games.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
    ON roster.league_season_id=v_trade.league_season_id AND roster.player_id=item.player_id
    JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi AND v_league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(v_trade.league_id,roster.player_id,season.season_year)>=v_league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'Incoming taxi player has reached the taxi tenure limit.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN league_member_taxi_exits exit
    ON exit.league_id=v_trade.league_id AND exit.member_id=item.to_member_id AND exit.player_id=item.player_id
    WHERE item.trade_id=p_trade_id AND (p_only_member_id IS NULL OR item.to_member_id=p_only_member_id) AND item.to_taxi) THEN
    RAISE EXCEPTION 'A promoted player cannot return to this team taxi squad.' USING ERRCODE='PT001';
  END IF;
  FOR v_team IN SELECT participant.*, member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id = p_only_member_id)
    ORDER BY participant.member_id LOOP
    IF EXISTS (SELECT 1 FROM unnest(v_team.drop_player_ids) drop_choice(player_id) WHERE
      NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id = v_trade.league_season_id
        AND roster.member_id = v_team.member_id AND roster.player_id = drop_choice.player_id)
      OR EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id AND item.player_id = drop_choice.player_id)
      OR private.is_reserved_trade_asset(v_trade.league_id, v_trade.league_season_id, v_team.member_id, drop_choice.player_id, NULL, p_trade_id)
      OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND status='pending' AND drop_player_id=drop_choice.player_id)) THEN
      RAISE EXCEPTION 'A selected trade drop is missing, reserved, or included in the offer.' USING ERRCODE = 'PT001';
    END IF;
    SELECT count(*) AS total, count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
      count(*) FILTER (WHERE on_ir) AS ir, count(*) FILTER (WHERE on_taxi) AS taxi INTO v_count
    FROM private.trade_resulting_roster(p_trade_id,v_team.member_id);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_team.roster_moves) move
      WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
        AND roster.member_id=v_team.member_id AND roster.player_id=(move->>'playerId')::uuid)
        OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)
        OR private.is_reserved_trade_asset(v_trade.league_id,v_trade.league_season_id,v_team.member_id,(move->>'playerId')::uuid,NULL,p_trade_id)
        OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND status='pending' AND drop_player_id=(move->>'playerId')::uuid)) THEN
      RAISE EXCEPTION 'A planned roster move is missing, reserved, or included in the offer.' USING ERRCODE='PT001';
    END IF;
    IF EXISTS (SELECT 1 FROM private.trade_resulting_roster(p_trade_id,v_team.member_id) result JOIN players player ON player.id=result.player_id
      WHERE result.on_ir AND NOT private.is_ir_designation(player.injury_status)) THEN
      RAISE EXCEPTION '% must activate or drop a player who is no longer eligible for IR.',v_team.team_name USING ERRCODE='PT001';
    END IF;
    IF EXISTS (SELECT 1 FROM private.trade_resulting_roster(p_trade_id,v_team.member_id) result
      JOIN league_seasons season ON season.id=v_trade.league_season_id
      WHERE result.on_taxi AND (NOT private.taxi_player_eligible(v_trade.league_id,result.player_id)
        OR (v_league.taxi_max_seasons IS NOT NULL AND season.season_year-private.taxi_start_year(v_trade.league_id,result.player_id,season.season_year)>=v_league.taxi_max_seasons)
        OR EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_trade.league_id AND member_id=v_team.member_id AND player_id=result.player_id))) THEN
      RAISE EXCEPTION '% must activate or drop an ineligible taxi player.',v_team.team_name USING ERRCODE='PT001';
    END IF;
    IF v_count.total > v_league.roster_size + v_league.ir_slots + v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the total roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.active > v_league.roster_size THEN
      RAISE EXCEPTION '% must change its trade plan to meet the active roster limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.ir > v_league.ir_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the IR limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
    IF v_count.taxi > v_league.taxi_slots THEN
      RAISE EXCEPTION '% must change its trade plan to meet the taxi limit.', v_team.team_name USING ERRCODE = 'PT001';
    END IF;
  END LOOP;
END;
$$;

-- Canonical SQL source for private.assert_trade_assets_acceptance_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
BEGIN
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

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_member uuid; v_player uuid; v_all uuid[];
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_participants participant JOIN league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = p_trade_id AND member.id = p_member_id AND member.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and an active or IR destination. Owned players cannot move back to taxi.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  FOR v_member IN SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member::text));
  END LOOP;
  FOR v_player IN SELECT DISTINCT id FROM (
    SELECT unnest(v_all) id UNION SELECT player_id FROM trade_items WHERE trade_id = p_trade_id
  ) ids WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND OR v_trade.status <> 'pending' OR v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
      AND roster.member_id=p_member_id AND roster.player_id=(move->>'playerId')::uuid)
      OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)) THEN
    RAISE EXCEPTION 'Moves must be retained players from your own roster.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids, roster_moves=p_roster_moves WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[],p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.set_trade_roster_plan_atomic(p_trade_id,p_member_id,p_user_id,p_taxi_player_ids,p_ir_player_ids,p_drop_player_ids,p_roster_moves);
  RETURN public.accept_trade_atomic(p_trade_id,p_member_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_league uuid;
  v_multi boolean;
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_source uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  SELECT league_id INTO v_member_league FROM league_members
    WHERE id=p_member_id AND user_id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
  END IF;

  v_multi := p_action LIKE '%-multi';
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- The separate statement sees a concurrent claim after its transaction commits.
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id OR v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN RETURN v_receipt.result_trade_id; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    IF p_payload ? 'recipientMemberId' AND v_recipient IS DISTINCT FROM (
      SELECT CASE WHEN p_action='counter' THEN proposer_member_id ELSE recipient_member_id END
        FROM public.trades WHERE id=v_source AND league_id=v_member_league
    ) THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[],
      COALESCE(p_payload->'rosterPlan'->'rosterMoves','[]'::jsonb));
  END IF;
  IF v_result IS NOT NULL THEN
    PERFORM private.validate_trade_rosters(v_result, p_member_id);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  RETURN v_result;
END;
$$;

-- Canonical SQL source for public.complete_accepted_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
   FOR UPDATE;

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
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.validate_trade_rosters(p_trade_id);

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
    UPDATE roster_players SET is_on_ir=v_move.destination='ir',is_on_taxi=false WHERE id=v_move.id;
    INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
      VALUES(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,
        CASE WHEN v_move.destination='ir' THEN 'ir_designate' WHEN v_move.is_on_taxi THEN 'taxi_return' ELSE 'ir_return' END,p_trade_id);
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
      IF v_item.to_taxi OR v_league.allow_inactive_trades THEN
        PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      END IF;
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
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  FOR v_member_lock IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_member_lock);
  END LOOP;
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

-- Canonical SQL source for public.process_next_waiver_claim_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_projected_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
  v_target_league_id uuid;
  v_target_season_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_player_name text;
  v_candidate record;
  v_to_ir boolean := false;
  v_ir_count int;
  v_ir_eligible boolean;
  v_ir_failure text;
  v_to_taxi boolean := false;
  v_taxi_failure text;
BEGIN
  FOR v_candidate IN
    WITH candidate_groups AS (
      SELECT
        candidate.league_id,
        candidate.league_season_id,
        candidate.player_id,
        min(candidate.process_date) AS process_date
        FROM waiver_claims AS candidate
        JOIN leagues AS claim_league
          ON claim_league.id = candidate.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = candidate.league_season_id
         AND claim_season.is_current = true
       WHERE candidate.status = 'pending'
         AND candidate.process_date <= p_process_date
         AND (candidate.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=candidate.league_id
           AND held.league_season_id=candidate.league_season_id AND held.player_id=candidate.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (candidate.process_date + time '03:00') AT TIME ZONE 'America/New_York')
       GROUP BY candidate.league_id, candidate.league_season_id, candidate.player_id
    ), league_candidates AS (
      SELECT DISTINCT ON (candidate_groups.league_id, candidate_groups.league_season_id)
        candidate_groups.*
        FROM candidate_groups
       ORDER BY candidate_groups.league_id, candidate_groups.league_season_id,
         candidate_groups.process_date, candidate_groups.player_id
    )
    SELECT league_candidates.league_id, league_candidates.league_season_id
      FROM league_candidates
     ORDER BY league_candidates.process_date, league_candidates.league_id,
       league_candidates.league_season_id, league_candidates.player_id
     LIMIT 128
  LOOP
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
        CONTINUE;
      END IF;
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;

      PERFORM 1
        FROM waiver_priorities AS wp_lock
       WHERE wp_lock.league_id = v_target_league_id
         AND wp_lock.league_season_id = v_target_season_id
       ORDER BY wp_lock.priority
       FOR UPDATE;

      SELECT wc.*
        INTO v_claim
        FROM waiver_claims AS wc
        JOIN waiver_priorities AS wp
          ON wp.league_id = wc.league_id
         AND wp.league_season_id = wc.league_season_id
         AND wp.member_id = wc.member_id
        JOIN leagues AS claim_league
          ON claim_league.id = wc.league_id
         AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status)
        JOIN league_seasons AS claim_season
          ON claim_season.id = wc.league_season_id
         AND claim_season.is_current = true
       WHERE wc.status = 'pending'
         AND wc.process_date <= p_process_date
         AND (wc.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '03:00') AT TIME ZONE 'America/New_York')
         AND wc.league_id = v_target_league_id
         AND wc.league_season_id = v_target_season_id
       ORDER BY
         wc.process_date ASC,
         CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
         wp.priority ASC,
         wc.claim_order ASC,
         wc.submitted_at ASC,
         wc.id ASC
       LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      -- Never wait for another team while an earlier batch item retains league rows.
      -- A busy head defers its whole league; lower-priority claims cannot pass it.
      IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text)) THEN
        RAISE EXCEPTION 'Waiver team is busy.' USING ERRCODE = 'PW001';
      END IF;

      -- A trade can clear the pending drop while we select the candidate.
      SELECT wc.* INTO v_claim FROM waiver_claims AS wc
       WHERE wc.id = v_claim.id AND wc.status = 'pending'
         AND wc.league_id = v_target_league_id AND wc.league_season_id = v_target_season_id
         AND wc.member_id = v_claim.member_id AND wc.player_id = v_claim.player_id
         AND wc.process_date <= p_process_date
         AND (wc.process_date + time '03:00') AT TIME ZONE 'America/New_York' <= now()
         AND NOT EXISTS (SELECT 1 FROM waiver_wire_log held WHERE held.league_id=wc.league_id
           AND held.league_season_id=wc.league_season_id AND held.player_id=wc.player_id
           AND held.cleared_at IS NULL AND held.clears_at > (wc.process_date + time '03:00') AT TIME ZONE 'America/New_York')
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waiver candidate changed.' USING ERRCODE = 'PW001';
      END IF;

      FOR v_lock_player_id IN
        SELECT DISTINCT pid
          FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
         WHERE pid IS NOT NULL
         ORDER BY pid ASC
      LOOP
        IF NOT pg_try_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text)) THEN
          RAISE EXCEPTION 'Waiver player is busy.' USING ERRCODE = 'PW001';
        END IF;
      END LOOP;

      SELECT wwl.id
        INTO v_waiver_log_id
        FROM waiver_wire_log AS wwl
       WHERE wwl.league_id = v_claim.league_id
         AND wwl.league_season_id = v_claim.league_season_id
         AND wwl.player_id = v_claim.player_id
         AND wwl.cleared_at IS NULL
         AND wwl.clears_at <= now()
       ORDER BY wwl.clears_at
       LIMIT 1
       FOR UPDATE;

      SELECT *
        INTO v_league
        FROM leagues
       WHERE id = v_claim.league_id
       FOR UPDATE NOWAIT;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'League not found.'
          USING ERRCODE = 'P0002';
      END IF;

      IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
        RAISE EXCEPTION 'Waivers require an active or playoff season.'
          USING ERRCODE = 'P0001';
      END IF;

      PERFORM 1
        FROM league_seasons AS season
       WHERE season.id = v_claim.league_season_id
         AND season.is_current = true
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Waivers require the current season.'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT display_name
        INTO v_player_name
        FROM players
       WHERE id = v_claim.player_id;

      BEGIN
        PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
      EXCEPTION
        WHEN SQLSTATE 'PA001' THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            SQLERRM,
            'waiver_claim_failed_add_limit',
            'Waiver claim failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
      END;

      IF v_league.waiver_mode = 'faab' THEN
        v_faab_balance := private.available_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
        IF v_faab_balance < v_claim.bid_amount THEN
          v_failure := 'Insufficient FAAB budget for this bid.';
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_priority'::waiver_claim_status,
            v_failure,
            'faab_bid_failed',
            'FAAB bid failed',
            jsonb_build_object('bid_amount', v_claim.bid_amount)
          );
          RETURN;
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM roster_players AS rp
         WHERE rp.league_id = v_claim.league_id
           AND rp.league_season_id = v_claim.league_season_id
           AND rp.player_id = v_claim.player_id
         FOR UPDATE
      ) THEN
        v_failure := 'Player already on a roster.';
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_priority'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      v_roster_size := v_league.roster_size;

      SELECT string_agg(problem.message,' ' ORDER BY problem.kind,problem.player_name,problem.roster_player_id)
        INTO v_ineligible FROM private.roster_problems(v_claim.league_id,v_claim.league_season_id,v_claim.member_id) problem;
      IF v_ineligible IS NOT NULL THEN
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,
          'failed_roster'::waiver_claim_status,v_ineligible
        );
        RETURN;
      END IF;

      v_to_ir := false;
      IF v_claim.to_ir THEN
        SELECT private.is_ir_designation(injury_status) INTO v_ir_eligible
          FROM players WHERE id = v_claim.player_id FOR SHARE;
        SELECT count(*) INTO v_ir_count FROM roster_players AS ir_roster
         WHERE ir_roster.member_id = v_claim.member_id AND ir_roster.league_season_id = v_claim.league_season_id AND ir_roster.is_on_ir;
        v_ir_failure := CASE
          WHEN NOT COALESCE(v_ir_eligible, false) THEN 'Player is no longer IR eligible.'
          WHEN v_ir_count >= COALESCE(v_league.ir_slots, 2) THEN 'Your IR slots are full.'
          WHEN v_league.status = 'offseason'::league_status THEN 'IR moves are unavailable in the offseason.'
          ELSE NULL
        END;
        v_to_ir := v_ir_failure IS NULL;
      END IF;

      v_to_taxi := false;
      v_taxi_failure := NULL;
      IF v_claim.to_taxi THEN
        BEGIN
          PERFORM private.authorize_taxi_acquisition(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id,'waiver',v_claim.id);
          PERFORM private.assert_taxi_acquisition_allowed(v_claim.league_id,v_claim.league_season_id,v_claim.member_id,v_claim.player_id);
          v_to_taxi := true;
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
          v_taxi_failure := SQLERRM;
        END;
      END IF;

      SELECT count(*)
        INTO v_active_count
        FROM roster_players AS rp
       WHERE rp.league_id = v_claim.league_id
         AND rp.league_season_id = v_claim.league_season_id
         AND rp.member_id = v_claim.member_id
         AND rp.is_on_ir = false
         AND rp.is_on_taxi = false;

      v_projected_active_count := v_active_count + CASE WHEN v_to_ir OR v_to_taxi THEN 0 ELSE 1 END - CASE WHEN v_claim.drop_player_id IS NULL OR v_to_ir OR v_to_taxi THEN 0 ELSE 1 END;

      IF NOT v_to_ir AND NOT v_to_taxi AND v_projected_active_count > COALESCE(v_roster_size, 20) THEN
        v_failure := CASE
          WHEN v_claim.to_ir THEN v_ir_failure || ' Your active roster is full.'
          WHEN v_claim.to_taxi THEN v_taxi_failure || ' Your active roster is full.'
          WHEN v_claim.drop_player_id IS NULL THEN 'Roster full and no drop player specified.'
          ELSE 'Waiver claim would leave your active roster over the limit.'
        END;
        RETURN QUERY SELECT * FROM private.fail_waiver_claim(
          v_claim.id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.player_id,
          'failed_roster'::waiver_claim_status,
          v_failure
        );
        RETURN;
      END IF;

      IF v_claim.drop_player_id IS NOT NULL AND NOT v_to_ir AND NOT v_to_taxi THEN
        SELECT validation.roster_player_id, validation.failure_reason
          INTO v_drop_roster_id, v_failure
          FROM private.validate_waiver_claim_drop_player(
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.drop_player_id,
            'Drop player is no longer on this active roster.'
          ) AS validation;

        IF v_failure IS NOT NULL THEN
          RETURN QUERY SELECT * FROM private.fail_waiver_claim(
            v_claim.id,
            v_claim.league_id,
            v_claim.league_season_id,
            v_claim.member_id,
            v_claim.player_id,
            'failed_roster'::waiver_claim_status,
            v_failure
          );
          RETURN;
        END IF;
      END IF;

      -- Mark the claim before the drop is released: the roster-lifecycle trigger
      -- clears stale drop selections on pending claims, and this claim's recorded
      -- drop must survive as history.
      UPDATE waiver_claims
         SET status = 'succeeded',
             processed_at = now(),
             failure_reason = NULL
       WHERE id = v_claim.id;

      IF v_drop_roster_id IS NOT NULL THEN
        PERFORM private.release_roster_player_to_waivers(
          v_drop_roster_id,
          v_claim.league_id,
          v_claim.league_season_id,
          v_claim.member_id,
          v_claim.drop_player_id,
          'waiver_drop',
          v_claim.id
        );
      END IF;

      INSERT INTO roster_players (
        league_id,
        league_season_id,
        member_id,
        player_id,
        acquired_via,
        is_on_ir,
        is_on_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver',
        v_to_ir,
        v_to_taxi
      );

      PERFORM private.assert_accepted_trade_capacity(v_claim.league_id,v_claim.league_season_id,v_claim.member_id);
      IF v_to_taxi THEN
        UPDATE public.notification_outbox SET body='Your waiver claim succeeded. Placed on taxi.',
          data=data || jsonb_build_object('destination','taxi','body','Your waiver claim succeeded. Placed on taxi.')
        WHERE dedupe_key='waiver_claim_won:' || v_claim.id::text || ':' || v_claim.member_id::text;
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_claim_id,
        acquired_to_taxi
      )
      VALUES (
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'waiver_add',
        v_claim.id,
        v_to_taxi
      );

      UPDATE waiver_wire_log
         SET cleared_at = now(),
             claimed_by_claim_id = v_claim.id
       WHERE id = v_waiver_log_id;

      IF v_league.waiver_mode = 'faab' THEN
        UPDATE faab_balances AS balance_row
           SET balance = balance_row.balance - v_claim.bid_amount,
               updated_at = now()
         WHERE balance_row.league_id = v_claim.league_id
           AND balance_row.league_season_id = v_claim.league_season_id
           AND balance_row.member_id = v_claim.member_id;
      END IF;

      PERFORM private.consume_weekly_add(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);

      SELECT max(wp.priority)
        INTO v_max_priority
        FROM waiver_priorities AS wp
       WHERE wp.league_id = v_claim.league_id
         AND wp.league_season_id = v_claim.league_season_id;

      UPDATE waiver_priorities AS priority_row
         SET priority = COALESCE(v_max_priority, 0) + 1
       WHERE priority_row.league_id = v_claim.league_id
         AND priority_row.league_season_id = v_claim.league_season_id
         AND priority_row.member_id = v_claim.member_id;

      PERFORM private.log_league_activity(
        v_claim.league_id,
        v_claim.league_season_id,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_won' ELSE 'waiver_claim_succeeded' END,
        CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid won' ELSE 'Waiver claim succeeded' END,
        COALESCE(v_player_name, 'Player') || CASE
          WHEN v_league.waiver_mode = 'faab' THEN format(' won for $%s.', v_claim.bid_amount)
          ELSE ' added from waivers.'
        END || CASE WHEN v_to_taxi THEN ' Placed on taxi.' ELSE '' END,
        NULL,
        v_claim.member_id,
        v_claim.player_id,
        NULL,
        v_claim.id,
        jsonb_build_object('bid_amount', v_claim.bid_amount, 'waiver_mode', v_league.waiver_mode)
      );

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

      RETURN QUERY
      WITH failed AS (
        UPDATE waiver_claims AS wc_other
           SET status = 'failed_priority',
               processed_at = now(),
               failure_reason = CASE
                 WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'
                 ELSE 'Claimed by higher-priority team.'
               END
         WHERE wc_other.status = 'pending'
           AND wc_other.league_id = v_claim.league_id
           AND wc_other.league_season_id = v_claim.league_season_id
           AND wc_other.player_id = v_claim.player_id
           AND wc_other.id <> v_claim.id
         RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason, wc_other.bid_amount
      ),
      logged AS (
        INSERT INTO league_activity (
          league_id,
          league_season_id,
          target_member_id,
          related_player_id,
          related_claim_id,
          event_type,
          title,
          body,
          metadata
        )
        SELECT
          v_claim.league_id,
          v_claim.league_season_id,
          failed.member_id,
          failed.player_id,
          failed.id,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END,
          CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid lost' ELSE 'Waiver claim failed' END,
          failed.failure_reason,
          jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)
        FROM failed
        RETURNING id
      )
      SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
        FROM failed;
      RETURN;
    EXCEPTION WHEN SQLSTATE 'PA008' OR SQLSTATE 'PT001' THEN
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        SQLERRM
      );
      RETURN;
    WHEN SQLSTATE 'PW001' OR lock_not_available THEN
      -- Release this attempt when its team, player, or league is busy.
      -- A batch can already hold a different league in the opposite order.
      CONTINUE;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_roster_preview(p_trade_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_error text; v_teams jsonb:='[]'; v_roster jsonb; v_drops jsonb; v_unavailable jsonb; v_destinations jsonb;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM league_members WHERE league_id=v_trade.league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'You cannot view this trade roster plan.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_league FROM leagues WHERE id=v_trade.league_id;
  FOR v_team IN SELECT participant.*,member.team_name FROM trade_participants participant
    JOIN league_members member ON member.id=participant.member_id WHERE trade_id=p_trade_id ORDER BY sort_order,member_id
  LOOP
    v_error:=NULL;
    BEGIN
      PERFORM private.validate_trade_rosters(p_trade_id,v_team.member_id);
      PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_team.member_id,p_trade_id);
    EXCEPTION WHEN SQLSTATE 'PT001' THEN v_error:=SQLERRM;
    END;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player.id,'name',player.display_name,
      'location',CASE WHEN result.on_taxi THEN 'taxi' WHEN result.on_ir THEN 'ir' ELSE 'active' END) ORDER BY player.display_name),'[]') INTO v_roster
    FROM private.trade_resulting_roster(p_trade_id,v_team.member_id) result JOIN players player ON player.id=result.player_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('playerId',player.id,'name',player.display_name) ORDER BY player.display_name),'[]') INTO v_drops
      FROM players player WHERE player.id=ANY(v_team.drop_player_ids);
    SELECT COALESCE(jsonb_object_agg(player_id::text,reason) FILTER(WHERE reason IS NOT NULL),'{}') INTO v_unavailable
    FROM (SELECT roster.player_id,CASE
      WHEN private.is_reserved_trade_asset(v_trade.league_id,v_trade.league_season_id,v_team.member_id,roster.player_id,NULL,p_trade_id) THEN 'Reserved by another trade.'
      WHEN EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id AND member_id=v_team.member_id
        AND status='pending' AND drop_player_id=roster.player_id) THEN 'Reserved as a pending waiver drop.'
      END AS reason FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id AND roster.member_id=v_team.member_id) unavailable;
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,jsonb_strip_nulls(jsonb_build_object(
      'ir',CASE WHEN v_league.ir_slots=0 THEN 'This league has no IR slots.' WHEN NOT private.is_ir_designation(player.injury_status) THEN 'IR requires an Out or IR designation.' END,
      'taxi',CASE WHEN v_league.taxi_slots=0 THEN 'This league has no taxi slots.'
        WHEN EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_trade.league_id AND member_id=v_team.member_id AND player_id=item.player_id) THEN 'This player cannot return to this team taxi squad.'
        WHEN NOT private.taxi_player_eligible(v_trade.league_id,item.player_id) THEN 'Taxi requires an eligible rookie or fewer than 65 known career games.'
        WHEN v_league.taxi_max_seasons IS NOT NULL AND (SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id)-private.taxi_start_year(v_trade.league_id,item.player_id,(SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id))>=v_league.taxi_max_seasons THEN 'This player has reached the taxi tenure limit.' END
    ))),'{}') INTO v_destinations FROM trade_items item JOIN players player ON player.id=item.player_id
      WHERE item.trade_id=p_trade_id AND item.to_member_id=v_team.member_id;
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object('memberId',v_team.member_id,'teamName',v_team.team_name,
      'unavailableMoves',v_unavailable,'unavailableDestinations',v_destinations,'roster',v_roster,'drops',v_drops,'moves',v_team.roster_moves,'error',v_error,
      'plan',jsonb_build_object('rosterMoves',v_team.roster_moves,'dropPlayerIds',to_jsonb(v_team.drop_player_ids),
        'taxiPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=v_team.member_id AND to_taxi),
        'irPlayerIds',(SELECT COALESCE(jsonb_agg(player_id),'[]') FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=v_team.member_id AND to_ir)),
      'limits',jsonb_build_object('active',v_league.roster_size,'ir',v_league.ir_slots,'taxi',v_league.taxi_slots)));
  END LOOP;
  RETURN v_teams;
END;
$$;

-- Canonical SQL source for private.accept_trade_participant_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.accept_trade_participant_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
  v_taxi_count int;
  v_taxi_incoming int;
  v_taxi_held int;
BEGIN
  -- Read first, lock parties and players in the order every roster mutation
  -- uses, then lock the trade row: a drop that expires this offer holds the
  -- member and player locks while it updates the trade, so taking the trade
  -- row first would deadlock against it.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;


  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status
     WHERE id = p_trade_id AND status = 'pending'::trade_status;
    RETURN jsonb_build_object(
      'expired', true,
      'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
      'allAccepted', false,
      'proposerMemberId', v_trade.proposer_member_id,
      'recipientMemberId', v_trade.recipient_member_id,
      'participantMemberIds', (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      )
    );
  END IF;


  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

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
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;


  IF NOT v_league.allow_inactive_trades THEN
    SELECT count(*) INTO v_taxi_incoming FROM trade_items
      WHERE trade_id=p_trade_id AND to_member_id=p_accepting_member_id AND player_id IS NOT NULL AND to_taxi;
    IF v_taxi_incoming>0 THEN
      SELECT count(*) INTO v_taxi_count FROM roster_players WHERE league_id=v_trade.league_id
        AND league_season_id=v_trade.league_season_id AND member_id=p_accepting_member_id AND is_on_taxi;
      SELECT count(*) INTO v_taxi_held FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.id<>p_trade_id AND trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status='accepted' AND item.to_member_id=p_accepting_member_id AND item.player_id IS NOT NULL AND item.to_taxi;
      IF v_taxi_count+v_taxi_incoming+v_taxi_held>COALESCE(v_league.taxi_slots,0) THEN
        RAISE EXCEPTION 'Your taxi squad is full (% slots). Accepted trades hold % taxi slot(s).',COALESCE(v_league.taxi_slots,0),v_taxi_held USING ERRCODE='P0001';
      END IF;
    END IF;
  END IF;

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.available_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member, p_trade_id);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
    END IF;
  END LOOP;

  PERFORM private.assert_trade_window(v_trade.league_id,
    ARRAY(SELECT pick_id FROM trade_items WHERE trade_id=p_trade_id AND pick_id IS NOT NULL));

  SELECT NOT EXISTS (SELECT 1 FROM trade_participants
    WHERE trade_id=p_trade_id AND member_id<>p_accepting_member_id AND accepted_at IS NULL)
    INTO v_all_accepted;

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id,
    NULL
  );

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NULL
       AND item.pick_id IS NULL
       AND COALESCE(item.faab_amount, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
  END IF;

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = CASE
             WHEN v_veto_window_hours = 0 THEN now() - interval '1 microsecond'
             ELSE now() + make_interval(hours => v_veto_window_hours)
           END,
           completed_at = NULL,
           vetoed_at = NULL
     WHERE id = p_trade_id
       AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to accept trade atomically';
    END IF;

    IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled'
       OR v_veto_window_hours = 0 THEN
      BEGIN
        PERFORM public.complete_accepted_trade_atomic(p_trade_id);
      EXCEPTION WHEN SQLSTATE 'PT002' THEN
        -- A receiving player's game is in progress: the accepted trade settles on a later queue run.
        NULL;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'expired', false,
    'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
  );
END;
$$;

DROP TRIGGER guard_trade_participant_plan_reservations ON public.trade_participants;
CREATE TRIGGER guard_trade_participant_plan_reservations BEFORE INSERT OR UPDATE OF drop_player_ids,roster_moves ON public.trade_participants FOR EACH ROW EXECUTE FUNCTION private.guard_trade_plan_reservations();
CREATE TRIGGER lock_accepted_trade_capacity BEFORE INSERT OR UPDATE OR DELETE ON public.roster_players FOR EACH ROW EXECUTE FUNCTION private.guard_accepted_trade_capacity();
CREATE CONSTRAINT TRIGGER check_accepted_trade_capacity AFTER INSERT OR UPDATE OR DELETE ON public.roster_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.guard_accepted_trade_capacity();
REVOKE ALL ON FUNCTION public.set_trade_roster_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_trade_roster_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.accept_trade_with_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.accept_trade_with_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION private.trade_resulting_roster(uuid,uuid),private.assert_accepted_trade_capacity(uuid,uuid,uuid,uuid),private.guard_accepted_trade_capacity() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.get_trade_roster_preview(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_trade_roster_preview(uuid,uuid) TO service_role;
