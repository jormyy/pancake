-- Taxi eligibility belongs to the player in a league, across owners and seasons.
CREATE TABLE public.league_player_taxi_exits (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  exited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(league_id,player_id)
);
ALTER TABLE public.league_player_taxi_exits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_player_taxi_exits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.league_player_taxi_exits TO authenticated,service_role;
CREATE POLICY taxi_exit_league_read ON public.league_player_taxi_exits FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.league_members m WHERE m.league_id=league_player_taxi_exits.league_id AND m.user_id=auth.uid()));

-- Capabilities come only from server-owned acquisition functions, not row provenance or request settings.
CREATE TABLE private.taxi_acquisition_context (
  transaction_id xid8 NOT NULL, league_id uuid NOT NULL, league_season_id uuid NOT NULL,
  member_id uuid NOT NULL, player_id uuid NOT NULL, source text NOT NULL, related_id uuid NOT NULL,
  PRIMARY KEY(transaction_id,league_id,league_season_id,member_id,player_id),
  CHECK(source IN ('draft','trade','carry_over','merge'))
);
REVOKE ALL ON private.taxi_acquisition_context FROM PUBLIC,anon,authenticated,service_role;

-- Preserve established history. Missing historical events cannot be reconstructed.
INSERT INTO public.league_player_taxi_exits(league_id,player_id,exited_at)
SELECT t.league_id,t.player_id,min(t.occurred_at) FROM public.roster_transactions t
WHERE t.transaction_type='taxi_return' OR (t.transaction_type IN ('ir_designate','drop','trade_out') AND EXISTS (
  SELECT 1 FROM public.roster_transactions enter_taxi WHERE enter_taxi.league_id=t.league_id
    AND enter_taxi.player_id=t.player_id AND enter_taxi.transaction_type='taxi_designate'
    AND enter_taxi.occurred_at<t.occurred_at AND NOT EXISTS (
      SELECT 1 FROM public.roster_transactions departed WHERE departed.league_id=t.league_id
        AND departed.player_id=t.player_id AND departed.occurred_at>enter_taxi.occurred_at
        AND departed.occurred_at<t.occurred_at AND departed.transaction_type IN ('taxi_return','ir_designate','drop','trade_out'))))
GROUP BY t.league_id,t.player_id ON CONFLICT DO NOTHING;
INSERT INTO public.league_player_taxi_exits(league_id,player_id,exited_at)
SELECT old.league_id,old.player_id,min(current_roster.acquired_at)
FROM public.roster_players old JOIN public.league_seasons old_season ON old_season.id=old.league_season_id
JOIN public.roster_players current_roster ON current_roster.league_id=old.league_id AND current_roster.player_id=old.player_id
JOIN public.league_seasons current_season ON current_season.id=current_roster.league_season_id
WHERE old.is_on_taxi AND NOT current_roster.is_on_taxi AND current_season.season_year>old_season.season_year
GROUP BY old.league_id,old.player_id ON CONFLICT DO NOTHING;


CREATE OR REPLACE FUNCTION private.authorize_taxi_acquisition(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid,
  p_source text, p_related_id uuid
)
RETURNS void LANGUAGE sql SET search_path = public, private AS $$
  INSERT INTO private.taxi_acquisition_context(transaction_id, league_id, league_season_id, member_id, player_id, source, related_id)
  VALUES (pg_current_xact_id(), p_league_id, p_season_id, p_member_id, p_player_id, p_source, p_related_id)
  ON CONFLICT (transaction_id, league_id, league_season_id, member_id, player_id)
  DO UPDATE SET source = EXCLUDED.source, related_id = EXCLUDED.related_id;
$$;

CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int;
BEGIN
  IF EXISTS (SELECT 1 FROM league_player_taxi_exits WHERE league_id=p_league_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left taxi and cannot return, even after a trade or season change.' USING ERRCODE='P0001';
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
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id AND r.is_on_taxi);
    END IF;
    IF NOT v_continuity AND (TG_OP='DELETE' OR NOT NEW.is_on_taxi OR v_entry) THEN
      INSERT INTO league_player_taxi_exits(league_id,player_id,exited_at)
      VALUES (OLD.league_id,OLD.player_id,now()) ON CONFLICT(league_id,player_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.clear_taxi_acquisition_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id()
    AND league_id=NEW.league_id AND league_season_id=NEW.league_season_id
    AND member_id=NEW.member_id AND player_id=NEW.player_id;
  RETURN NEW;
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

  -- Prior+1 alone breaks a league that skipped a season or was created
  -- off-cycle: the derived year would never match season_weeks. The real
  -- calendar wins whenever it is ahead.
  v_new_year := GREATEST(
    v_current_season.season_year + 1,
    public.current_season_year_et(now())
  );
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

  INSERT INTO league_seasons (league_id, season_year, is_current, rookie_draft_scheduled_at)
  VALUES (p_league_id, v_new_year, true, now() + interval '60 days')
  RETURNING id INTO v_new_season_id;

  PERFORM private.authorize_taxi_acquisition(p_league_id,v_new_season_id,member_id,player_id,'carry_over',v_current_season.id)
    FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_current_season.id AND is_on_taxi;

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

  -- The trade deadline repeats every season.
  UPDATE leagues
     SET status = 'offseason',
         trade_deadline = private.trade_deadline_for_season(trade_deadline, v_new_year)
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
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

  INSERT INTO league_player_taxi_exits(league_id,player_id,exited_at)
    SELECT league_id,winner_id,exited_at FROM league_player_taxi_exits WHERE player_id=loser_id
    ON CONFLICT(league_id,player_id) DO UPDATE SET exited_at=LEAST(league_player_taxi_exits.exited_at,EXCLUDED.exited_at);
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id() AND source='merge' AND related_id=loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;

REVOKE ALL ON FUNCTION private.authorize_taxi_acquisition(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.assert_taxi_acquisition_allowed(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.enforce_taxi_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.clear_taxi_acquisition_context() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER enforce_taxi_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON public.roster_players
FOR EACH ROW EXECUTE FUNCTION private.enforce_taxi_lifecycle();
CREATE TRIGGER z_clear_taxi_acquisition_context AFTER INSERT OR UPDATE ON public.roster_players
FOR EACH ROW EXECUTE FUNCTION private.clear_taxi_acquisition_context();
