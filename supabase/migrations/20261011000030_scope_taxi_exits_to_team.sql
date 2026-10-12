-- Exit lockout belongs to one team in one league, across seasons and reacquisitions.
-- Keep the old global rows as historical evidence only. Their member is unknown.
COMMENT ON TABLE public.league_player_taxi_exits IS
  'Superseded global taxi exit evidence. Not used for eligibility; do not infer a team from these rows.';
ALTER TABLE public.league_members ADD CONSTRAINT league_members_league_id_id_key UNIQUE (league_id,id);
CREATE TABLE public.league_member_taxi_exits (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  exited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(league_id,member_id,player_id),
  FOREIGN KEY(league_id,member_id) REFERENCES public.league_members(league_id,id) ON DELETE CASCADE
);
ALTER TABLE public.league_member_taxi_exits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_member_taxi_exits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.league_member_taxi_exits TO authenticated,service_role;
CREATE POLICY taxi_exit_team_league_read ON public.league_member_taxi_exits FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.league_members m
    WHERE m.league_id=league_member_taxi_exits.league_id AND m.user_id=auth.uid()));

-- Historical activation calls can be no-ops. Every exit therefore needs a known
-- preceding taxi entry for the same team. Equal-time conflicting events remain unknown.
WITH events AS MATERIALIZED (
  SELECT t.*,
    (t.transaction_type='taxi_designate'
      OR (t.transaction_type='carry_over' AND EXISTS(SELECT 1 FROM public.roster_transactions c
        WHERE c.league_id=t.league_id AND c.league_season_id=t.league_season_id AND c.member_id=t.member_id
          AND c.player_id=t.player_id AND c.transaction_type='taxi_designate' AND c.occurred_at=t.occurred_at))
      OR (t.transaction_type='draft_won' AND (
        EXISTS(SELECT 1 FROM public.nominations n JOIN public.drafts d ON d.id=n.draft_id
          WHERE n.id=t.related_nomination_id AND n.player_id=t.player_id
            AND n.winning_member_id=t.member_id AND n.current_bid_to_taxi AND n.status='sold'
            AND d.league_id=t.league_id AND d.league_season_id=t.league_season_id AND NOT d.is_mock)
        OR EXISTS(SELECT 1 FROM public.snake_draft_picks sp JOIN public.drafts d ON d.id=sp.draft_id
          WHERE sp.player_id=t.player_id AND sp.member_id=t.member_id AND sp.to_taxi
            AND sp.picked_at IS NOT NULL AND sp.picked_at<=t.occurred_at
            AND d.league_id=t.league_id AND d.league_season_id=t.league_season_id AND NOT d.is_mock)))
      OR (t.transaction_type='trade_in' AND EXISTS(
        SELECT 1 FROM public.trade_items i JOIN public.trades tr ON tr.id=i.trade_id
        WHERE i.trade_id=t.related_trade_id AND i.player_id=t.player_id AND i.to_member_id=t.member_id AND i.to_taxi
          AND tr.league_id=t.league_id AND tr.league_season_id=t.league_season_id AND tr.status='completed')))
      AS is_taxi_entry
  FROM public.roster_transactions t
  -- Returning from IR does not change taxi status.
  WHERE t.transaction_type<>'ir_return'
), proven AS (
  SELECT departed.league_id,departed.member_id,departed.player_id,departed.occurred_at
  FROM events departed JOIN public.league_members m ON m.id=departed.member_id AND m.league_id=departed.league_id
  WHERE departed.transaction_type IN ('taxi_return','ir_designate','drop','fa_drop','waiver_drop','trade_out')
    AND (SELECT bool_and(prior.is_taxi_entry) FROM events prior
      WHERE prior.league_id=departed.league_id AND prior.member_id=departed.member_id
        AND prior.player_id=departed.player_id
        AND prior.occurred_at=(SELECT max(e.occurred_at) FROM events e
          WHERE e.league_id=departed.league_id AND e.member_id=departed.member_id
            AND e.player_id=departed.player_id AND e.occurred_at<departed.occurred_at))
    AND NOT EXISTS(SELECT 1 FROM events same_time
      WHERE same_time.league_id=departed.league_id AND same_time.member_id=departed.member_id
        AND same_time.player_id=departed.player_id AND same_time.occurred_at=departed.occurred_at
        AND same_time.id<>departed.id AND same_time.is_taxi_entry)
)
INSERT INTO public.league_member_taxi_exits(league_id,member_id,player_id,exited_at)
SELECT league_id,member_id,player_id,min(occurred_at) FROM proven GROUP BY league_id,member_id,player_id
ON CONFLICT(league_id,member_id,player_id) DO UPDATE
SET exited_at=LEAST(league_member_taxi_exits.exited_at,EXCLUDED.exited_at);

-- A later non-taxi roster for that same team proves it exited that team's taxi.
-- A different owner's roster is never evidence against this team or its new owner.
INSERT INTO public.league_member_taxi_exits(league_id,member_id,player_id,exited_at)
SELECT old.league_id,old.member_id,old.player_id,min(later.acquired_at)
FROM public.roster_players old JOIN public.league_seasons old_season ON old_season.id=old.league_season_id
JOIN public.roster_players later ON later.league_id=old.league_id AND later.member_id=old.member_id AND later.player_id=old.player_id
JOIN public.league_seasons later_season ON later_season.id=later.league_season_id
WHERE old.is_on_taxi AND NOT later.is_on_taxi AND later_season.season_year>old_season.season_year
GROUP BY old.league_id,old.member_id,old.player_id
ON CONFLICT(league_id,member_id,player_id) DO UPDATE
SET exited_at=LEAST(league_member_taxi_exits.exited_at,EXCLUDED.exited_at);

CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int;
BEGIN
  IF EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=p_member_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left your team''s taxi squad and cannot return to it, even after reacquisition or a season change.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id=p_player_id AND years_exp=0 AND nba_draft_number IS NOT NULL) THEN
    RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.' USING ERRCODE='P0001';
  END IF;
  IF private.roster_status_game_started(p_player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.' USING ERRCODE='P0001';
  END IF;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=p_league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players
   WHERE league_id=p_league_id AND league_season_id=p_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count >= COALESCE(v_slots,0) THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots).', COALESCE(v_slots,0) USING ERRCODE='P0001';
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION private.can_acquire_draft_taxi(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_player_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM leagues l WHERE l.id=p_league_id AND l.taxi_slots >
    (SELECT count(*) FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.member_id=p_member_id AND r.is_on_taxi))
  AND EXISTS(SELECT 1 FROM players p WHERE (p_player_id IS NULL OR p.id=p_player_id)
    AND (p_draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM nominations n WHERE n.draft_id=p_draft_id AND n.player_id=p.id))
    AND p.years_exp=0 AND p.nba_draft_number IS NOT NULL
    AND NOT private.roster_status_game_started(p.id)
    AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits x WHERE x.league_id=p_league_id AND x.member_id=p_member_id AND x.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.player_id=p.id));
$$;


CREATE OR REPLACE FUNCTION private.enforce_taxi_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  v_entry boolean := false;
  v_continuity boolean := false;
  v_context private.taxi_acquisition_context%ROWTYPE;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'INSERT' THEN
      v_entry := NEW.is_on_taxi;
    ELSE
      v_entry := NEW.is_on_taxi AND (NOT OLD.is_on_taxi OR
        (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id)
          IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id));
    END IF;
    IF v_entry THEN
      SELECT * INTO v_context FROM private.taxi_acquisition_context
       WHERE transaction_id=pg_current_xact_id() AND league_id=NEW.league_id
         AND league_season_id=NEW.league_season_id AND member_id=NEW.member_id AND player_id=NEW.player_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Players can enter taxi only through a draft or trade acquisition.' USING ERRCODE='P0001';
      END IF;
      IF v_context.source='carry_over' AND TG_OP='INSERT' THEN
        v_continuity := EXISTS (SELECT 1 FROM roster_players
          WHERE league_id=NEW.league_id AND league_season_id=v_context.related_id
            AND member_id=NEW.member_id AND player_id=NEW.player_id AND is_on_taxi);
      ELSIF v_context.source='merge' AND TG_OP='UPDATE' THEN
        v_continuity := OLD.is_on_taxi AND OLD.player_id=v_context.related_id
          AND (OLD.league_id,OLD.league_season_id,OLD.member_id)=(NEW.league_id,NEW.league_season_id,NEW.member_id);
      ELSIF v_context.source IN ('draft','trade') THEN
        IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id=NEW.league_season_id AND league_id=NEW.league_id AND is_current) THEN
          RAISE EXCEPTION 'Taxi acquisitions require the current season.' USING ERRCODE='P0001';
        END IF;
        PERFORM private.assert_taxi_acquisition_allowed(NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id);
      ELSE
        RAISE EXCEPTION 'Invalid taxi acquisition.' USING ERRCODE='P0001';
      END IF;
      IF v_context.source IN ('carry_over','merge') AND NOT v_continuity THEN
        RAISE EXCEPTION 'Taxi continuity does not match the existing roster.' USING ERRCODE='P0001';
      END IF;

    END IF;
  END IF;

  IF TG_OP <> 'INSERT' AND OLD.is_on_taxi
     AND EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id)
     AND EXISTS (SELECT 1 FROM players WHERE id=OLD.player_id)
     AND EXISTS (SELECT 1 FROM league_seasons WHERE id=OLD.league_season_id AND is_current) THEN
    IF TG_OP='DELETE' THEN
      -- Removing a duplicate identity that still has a taxi row is continuity.
      v_continuity := EXISTS (
        SELECT 1 FROM private.taxi_acquisition_context c JOIN roster_players r
          ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id AND r.player_id=c.player_id
         WHERE c.transaction_id=pg_current_xact_id() AND c.source='merge' AND c.related_id=OLD.player_id
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id
           AND c.member_id=OLD.member_id AND r.member_id=OLD.member_id AND r.is_on_taxi);
    END IF;
    IF NOT v_continuity AND (TG_OP='DELETE' OR NOT NEW.is_on_taxi OR v_entry) THEN
      INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at)
      VALUES (OLD.league_id,OLD.member_id,OLD.player_id,now()) ON CONFLICT(league_id,member_id,player_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION merge_players(winner_id uuid, loser_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner players%ROWTYPE;
  v_loser players%ROWTYPE;
BEGIN
  IF winner_id = loser_id THEN RETURN; END IF;
  PERFORM id FROM players WHERE id IN (winner_id, loser_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_winner FROM players WHERE id = winner_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_loser FROM players WHERE id = loser_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Release unique provider links before moving them to the surviving identity.
  UPDATE players SET
    sleeper_id = CASE WHEN v_winner.sleeper_id IS NULL THEN NULL ELSE sleeper_id END,
    nba_id = CASE WHEN v_winner.nba_id IS NULL THEN NULL ELSE nba_id END,
    espn_id = CASE WHEN v_winner.espn_id IS NULL THEN NULL ELSE espn_id END,
    sportsdata_id = CASE WHEN v_winner.sportsdata_id IS NULL THEN NULL ELSE sportsdata_id END
  WHERE id = loser_id;

  UPDATE players SET
    sleeper_id = COALESCE(v_winner.sleeper_id, v_loser.sleeper_id),
    nba_id = COALESCE(v_winner.nba_id, v_loser.nba_id),
    espn_id = COALESCE(v_winner.espn_id, v_loser.espn_id),
    sportsdata_id = COALESCE(v_winner.sportsdata_id, v_loser.sportsdata_id),
    nba_team = COALESCE(v_winner.nba_team, v_loser.nba_team),
    position = COALESCE(v_winner.position, v_loser.position),
    eligible_positions = CASE WHEN cardinality(v_winner.eligible_positions) = 0
      THEN v_loser.eligible_positions ELSE v_winner.eligible_positions END,
    headshot_url = COALESCE(v_winner.headshot_url, v_loser.headshot_url),
    jersey_number = COALESCE(v_winner.jersey_number, v_loser.jersey_number),
    years_exp = COALESCE(v_winner.years_exp, v_loser.years_exp),
    nba_draft_number = COALESCE(v_winner.nba_draft_number, v_loser.nba_draft_number),
    -- A backfill stub has no team or position. Its empty injury status is unknown.
    injury_status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_winner.injury_status, v_loser.injury_status) ELSE v_winner.injury_status END,
    status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_loser.status, v_winner.status) ELSE v_winner.status END,
    dynasty_rank = COALESCE(v_winner.dynasty_rank, v_loser.dynasty_rank),
    dynasty_rank_source = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_source ELSE v_winner.dynasty_rank_source END,
    dynasty_rank_fetched_at = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_fetched_at ELSE v_winner.dynasty_rank_fetched_at END
  WHERE id = winner_id;

  -- A member who already holds the winner on the active roster keeps that row,
  -- so their listings, lineups, pending drops and offers move to the winner
  -- before their loser row goes; the roster lifecycle trigger then finds
  -- nothing of theirs under the old identity. Every other member's state is
  -- cleared by that trigger when their loser row is deleted below, or moves
  -- with their roster row when it is re-pointed.
  DELETE FROM trade_block_items AS stale
    WHERE stale.player_id = loser_id
      AND EXISTS (
        SELECT 1 FROM trade_block_items AS kept
         WHERE kept.league_id = stale.league_id
           AND kept.member_id = stale.member_id
           AND kept.player_id = winner_id
      );
  UPDATE trade_block_items AS listing
     SET player_id = winner_id
   WHERE listing.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
         JOIN league_seasons AS season ON season.id = own.league_season_id AND season.is_current = true
        WHERE own.player_id = winner_id AND own.member_id = listing.member_id AND own.league_id = listing.league_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  DELETE FROM weekly_lineups
    WHERE player_id = loser_id
      AND (league_id, league_season_id, member_id, game_date) IN (
        SELECT league_id, league_season_id, member_id, game_date
          FROM weekly_lineups WHERE player_id = winner_id
      );
  UPDATE weekly_lineups AS lineup
     SET player_id = winner_id
   WHERE lineup.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = lineup.member_id AND own.league_season_id = lineup.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE waiver_claims AS claim
     SET drop_player_id = winner_id
   WHERE claim.drop_player_id = loser_id
     AND claim.status = 'pending'::waiver_claim_status
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = claim.member_id AND own.league_season_id = claim.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE trade_items AS item
     SET player_id = winner_id
    FROM trades AS trade
   WHERE trade.id = item.trade_id
     AND item.player_id = loser_id
     AND trade.status IN ('pending'::trade_status, 'accepted'::trade_status)
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = item.from_member_id AND own.league_season_id = trade.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  PERFORM private.authorize_taxi_acquisition(league_id,league_season_id,member_id,winner_id,'merge',loser_id)
    FROM roster_players WHERE player_id=loser_id AND is_on_taxi;

  -- roster_players: drop the loser's rows that already have a winner row in the
  -- same (league, season), then re-point the rest.
  DELETE FROM roster_players
    WHERE player_id = loser_id
      AND (league_id, league_season_id) IN (
        SELECT league_id, league_season_id FROM roster_players WHERE player_id = winner_id
      );
  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;

  -- Everything still under the loser identity belongs to a re-pointed roster
  -- row or to history; it moves with the identity.
  UPDATE trade_block_items SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups    SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_projections
    WHERE player_id = loser_id
      AND (season_year, week_number) IN (
        SELECT season_year, week_number FROM player_projections WHERE player_id = winner_id
      );
  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;

  -- nominations: UNIQUE(draft_id, player_id) — drop loser dupes per draft first.
  DELETE FROM nominations
    WHERE player_id = loser_id
      AND draft_id IN (SELECT draft_id FROM nominations WHERE player_id = winner_id);
  UPDATE nominations SET player_id = winner_id WHERE player_id = loser_id;

  UPDATE waiver_claims       SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET drop_player_id = winner_id WHERE drop_player_id = loser_id;
  UPDATE waiver_wire_log     SET player_id = winner_id WHERE player_id = loser_id;

  -- One identity cannot be rostered and clearing waivers in the same season.
  UPDATE waiver_wire_log AS log
     SET cleared_at = now()
   WHERE log.player_id = winner_id
     AND log.cleared_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM roster_players AS roster
        WHERE roster.league_id = log.league_id
          AND roster.league_season_id = log.league_season_id
          AND roster.player_id = winner_id
     );
  UPDATE trade_items         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE snake_draft_picks   SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  -- Retain unattributed legacy evidence without using it for eligibility.
  INSERT INTO league_player_taxi_exits(league_id,player_id,exited_at)
    SELECT league_id,winner_id,exited_at FROM league_player_taxi_exits WHERE player_id=loser_id
    ON CONFLICT(league_id,player_id) DO UPDATE SET exited_at=LEAST(league_player_taxi_exits.exited_at,EXCLUDED.exited_at);
  INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at)
    SELECT league_id,member_id,winner_id,exited_at FROM league_member_taxi_exits WHERE player_id=loser_id
    ON CONFLICT(league_id,member_id,player_id) DO UPDATE SET exited_at=LEAST(league_member_taxi_exits.exited_at,EXCLUDED.exited_at);
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id() AND source='merge' AND related_id=loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.toggle_taxi_atomic(p_roster_player_id uuid, p_to_taxi boolean, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_roster_size int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT p_to_taxi AND NOT v_rp.is_on_taxi THEN
    RETURN;
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);

  IF p_to_taxi THEN
    RAISE EXCEPTION 'Players can enter taxi only through a draft or trade acquisition.'
      USING ERRCODE = 'P0001';
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_taxi = p_to_taxi
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle taxi status'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    CASE WHEN p_to_taxi THEN 'taxi_designate' ELSE 'taxi_return' END
  );
END;
$function$;
