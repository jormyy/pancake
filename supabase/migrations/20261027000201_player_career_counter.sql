ALTER TABLE public.players
  ADD COLUMN career_games_prior integer CHECK (career_games_prior >= 0),
  ADD COLUMN career_games_prior_checked_at timestamptz;

CREATE OR REPLACE FUNCTION private.player_career_values(p_player_id uuid, p_years_exp integer, p_prior integer)
RETURNS TABLE(prior integer, games integer) LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH observed AS (
    SELECT count(*) FILTER (WHERE s.minutes_played > 0 AND NOT s.did_not_play
      AND g.season_year >= 2021 AND g.game_date >= DATE '2020-12-22')::integer AS games,
      min(g.season_year) AS first_season
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=p_player_id AND public.is_regular_season_game_id(g.nba_game_id)
  ), resolved AS (
    SELECT games, coalesce(p_prior, CASE WHEN p_years_exp >= 0
      AND public.current_season_year_et() - p_years_exp >= 2021
      AND coalesce(first_season, 2021) >= 2021 THEN 0 END) AS prior FROM observed
  )
  SELECT prior, CASE WHEN prior IS NOT NULL THEN prior + games WHEN games >= 65 THEN games END FROM resolved;
$$;


CREATE OR REPLACE FUNCTION private.recount_player_career_games(p_player_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player public.players%ROWTYPE; v_prior integer; v_games integer;
BEGIN
  FOR v_player IN SELECT * FROM public.players WHERE id=ANY(p_player_ids) ORDER BY id FOR UPDATE LOOP
    SELECT prior, games INTO v_prior, v_games FROM private.player_career_values(v_player.id,v_player.years_exp,v_player.career_games_prior);
    UPDATE public.players SET career_games_prior=v_prior, career_regular_season_games=v_games,
      career_games_prior_checked_at=CASE WHEN v_player.career_games_prior IS NULL AND v_prior IS NOT NULL
        THEN clock_timestamp() ELSE career_games_prior_checked_at END
    WHERE id=v_player.id AND (career_games_prior,career_regular_season_games) IS DISTINCT FROM (v_prior,v_games);
  END LOOP;
END;
$$;


CREATE OR REPLACE FUNCTION private.guard_player_career_games()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prior integer; v_games integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.career_regular_season_games IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW.years_exp IS NOT DISTINCT FROM OLD.years_exp
    AND NEW.career_games_prior IS NOT DISTINCT FROM OLD.career_games_prior
    AND NEW.career_games_checked_at IS NOT DISTINCT FROM OLD.career_games_checked_at THEN
    RETURN NEW;
  END IF;
  SELECT prior,games INTO v_prior,v_games FROM private.player_career_values(NEW.id,NEW.years_exp,NEW.career_games_prior);
  NEW.career_games_prior := v_prior;
  NEW.career_regular_season_games := v_games;
  IF v_prior IS NOT NULL AND NEW.career_games_prior_checked_at IS NULL THEN NEW.career_games_prior_checked_at:=clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION private.recount_changed_player_careers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ids uuid[];
BEGIN
  IF TG_OP='INSERT' THEN SELECT array_agg(DISTINCT player_id) INTO v_ids FROM career_new_rows;
  ELSIF TG_OP='DELETE' THEN SELECT array_agg(DISTINCT player_id) INTO v_ids FROM career_old_rows;
  ELSE SELECT array_agg(player_id) INTO v_ids FROM (SELECT player_id FROM career_new_rows UNION SELECT player_id FROM career_old_rows) changed;
  END IF;
  PERFORM private.recount_player_career_games(v_ids);
  RETURN NULL;
END;
$$;


CREATE OR REPLACE FUNCTION private.recount_changed_game_careers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.nba_game_id,NEW.season_year,NEW.game_date) IS DISTINCT FROM (OLD.nba_game_id,OLD.season_year,OLD.game_date) THEN
    PERFORM private.recount_player_career_games(ARRAY(SELECT player_id FROM public.player_game_stats WHERE game_id=NEW.id));
  END IF;
  RETURN NULL;
END;
$$;


CREATE OR REPLACE FUNCTION public.claim_player_career_prior_atomic(p_player_id uuid, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.players SET career_games_prior_checked_at=p_now
  WHERE id=p_player_id AND (years_exp IS NULL OR (career_games_prior IS NULL AND coalesce(career_regular_season_games,0)<65))
    AND (career_games_prior_checked_at IS NULL OR career_games_prior_checked_at<=p_now-interval '7 days');
  RETURN FOUND;
END;
$$;


CREATE OR REPLACE FUNCTION public.complete_player_career_prior_atomic(
  p_player_id uuid, p_prior integer, p_espn_id text, p_nba_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_prior IS NULL OR p_prior<0 THEN RAISE EXCEPTION 'A nonnegative career prior is required.' USING ERRCODE='22023'; END IF;
  UPDATE public.players SET career_games_prior=p_prior
  WHERE id=p_player_id AND career_games_prior IS NULL
    AND espn_id IS NOT DISTINCT FROM nullif(p_espn_id,'') AND nba_id IS NOT DISTINCT FROM nullif(p_nba_id,'');
  RETURN FOUND;
END;
$$;


-- Canonical SQL source for public.merge_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  PERFORM pg_advisory_xact_lock(1347174745, 1);
  IF winner_id = loser_id THEN RETURN; END IF;
  PERFORM id FROM players WHERE id IN (winner_id, loser_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_winner FROM players WHERE id = winner_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_loser FROM players WHERE id = loser_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF (v_winner.nba_id IS NOT NULL AND v_loser.nba_id IS NOT NULL AND v_winner.nba_id <> v_loser.nba_id)
    OR (v_winner.espn_id IS NOT NULL AND v_loser.espn_id IS NOT NULL AND v_winner.espn_id <> v_loser.espn_id)
    OR (v_winner.sleeper_id IS NOT NULL AND v_loser.sleeper_id IS NOT NULL AND v_winner.sleeper_id <> v_loser.sleeper_id)
    OR (v_winner.sportsdata_id IS NOT NULL AND v_loser.sportsdata_id IS NOT NULL AND v_winner.sportsdata_id <> v_loser.sportsdata_id) THEN
    RAISE EXCEPTION 'Cannot merge conflicting provider identities.' USING ERRCODE = '23514';
  END IF;

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
    career_games_prior = COALESCE(v_winner.career_games_prior, v_loser.career_games_prior),
    career_games_prior_checked_at = CASE WHEN v_winner.career_games_prior IS NOT NULL THEN v_winner.career_games_prior_checked_at
      WHEN v_loser.career_games_prior IS NOT NULL THEN v_loser.career_games_prior_checked_at
      ELSE GREATEST(v_winner.career_games_prior_checked_at,v_loser.career_games_prior_checked_at) END,
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

  -- The same team's existing taxi acquisition survives a duplicate active/IR
  -- identity. Normal delete guards and cleanup apply to the redundant row.
  DELETE FROM roster_players AS canonical
  USING roster_players AS taxi
  WHERE canonical.player_id = winner_id
    AND taxi.player_id = loser_id
    AND canonical.league_id = taxi.league_id
    AND canonical.league_season_id = taxi.league_season_id
    AND canonical.member_id = taxi.member_id
    AND NOT canonical.is_on_taxi
    AND taxi.is_on_taxi;

  -- Otherwise, a member who already holds the winner active keeps that row,
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

  -- Keep both original auctions and their bid/transaction links when identities collide.
  -- One unmarked nomination per draft/player still guards ordinary entry.
  UPDATE nominations AS loser
     SET merged_from_player_id = COALESCE(loser.merged_from_player_id,loser_id)
   WHERE loser.player_id = loser_id
     AND EXISTS (SELECT 1 FROM nominations AS winner
       WHERE winner.draft_id=loser.draft_id AND winner.player_id=winner_id);
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

  -- A membership keeps the side its box lists him under (the ESPN release sweep moves him to it): the
  -- survivor's side stays, and a merged-away side fills one the survivor lacks.
  INSERT INTO private.player_game_memberships(player_id, game_id, first_seen_at, nba_team)
    SELECT winner_id, game_id, first_seen_at, nba_team FROM private.player_game_memberships WHERE player_id = loser_id
    ON CONFLICT (player_id, game_id) DO UPDATE
      SET first_seen_at = LEAST(player_game_memberships.first_seen_at, EXCLUDED.first_seen_at),
    nba_team = COALESCE(player_game_memberships.nba_team, EXCLUDED.nba_team);

  -- The time ESPN last listed this person anchors the release sweep's departure evidence, and the time it
  -- has listed him on that team since gates the box-to-ESPN link, so the survivor keeps the later of the two
  -- listings whole rather than losing the merged-away one with its row.
  INSERT INTO private.player_espn_listings(player_id, nba_team, listed_at, team_since)
    SELECT winner_id, nba_team, listed_at, team_since FROM private.player_espn_listings WHERE player_id = loser_id
    ON CONFLICT (player_id) DO UPDATE SET nba_team = EXCLUDED.nba_team, listed_at = EXCLUDED.listed_at,
        team_since = EXCLUDED.team_since
      WHERE EXCLUDED.listed_at > player_espn_listings.listed_at;

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

  UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE fantasypros_projection_rows SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE dynasty_news SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE league_activity SET related_player_id = winner_id WHERE related_player_id = loser_id;

  INSERT INTO player_watches(league_id, member_id, player_id, created_at)
    SELECT league_id, member_id, winner_id, created_at FROM player_watches
    WHERE player_id = loser_id ORDER BY member_id
    ON CONFLICT (member_id, player_id) DO NOTHING;

  DELETE FROM players WHERE id = loser_id;
  PERFORM private.recount_player_career_games(ARRAY[winner_id]);
END;
$$;

CREATE TRIGGER player_career_guard BEFORE INSERT OR UPDATE OF years_exp,career_games_prior,career_games_checked_at
  ON public.players FOR EACH ROW EXECUTE FUNCTION private.guard_player_career_games();
CREATE TRIGGER career_stats_insert AFTER INSERT ON public.player_game_stats
  REFERENCING NEW TABLE AS career_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.recount_changed_player_careers();
CREATE TRIGGER career_stats_update AFTER UPDATE ON public.player_game_stats
  REFERENCING OLD TABLE AS career_old_rows NEW TABLE AS career_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.recount_changed_player_careers();
CREATE TRIGGER career_stats_delete AFTER DELETE ON public.player_game_stats
  REFERENCING OLD TABLE AS career_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.recount_changed_player_careers();
CREATE TRIGGER career_game_update AFTER UPDATE OF nba_game_id,season_year,game_date ON public.nba_games
  FOR EACH ROW EXECUTE FUNCTION private.recount_changed_game_careers();

REVOKE ALL ON FUNCTION public.claim_player_career_prior_atomic(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_player_career_prior_atomic(uuid,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_player_career_prior_atomic(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_player_career_prior_atomic(uuid,integer,text,text) TO service_role;
REVOKE ALL ON FUNCTION private.player_identity_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.player_identity_team(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.player_career_values(uuid,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.recount_player_career_games(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_player_career_games() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.recount_changed_player_careers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.recount_changed_game_careers() FROM PUBLIC, anon, authenticated;

SELECT public.merge_duplicate_players();
SELECT private.recount_player_career_games(ARRAY(SELECT id FROM public.players));
