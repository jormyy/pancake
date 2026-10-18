SET lock_timeout = '5s';
SET statement_timeout = '2min';
ALTER TABLE public.leagues ADD COLUMN team_limit int NOT NULL DEFAULT 10 CHECK (team_limit BETWEEN 2 AND 30);
ALTER TABLE public.leagues ADD COLUMN taxi_rule text NOT NULL DEFAULT 'drafted_rookies' CHECK (taxi_rule IN ('drafted_rookies','rookies_or_64_games'));
ALTER TABLE public.leagues ADD COLUMN taxi_max_seasons int CHECK (taxi_max_seasons BETWEEN 1 AND 2);
ALTER TABLE public.leagues ADD COLUMN allow_inactive_trades boolean NOT NULL DEFAULT false;
ALTER TABLE public.leagues ADD COLUMN playoff_entrants int CHECK (playoff_entrants BETWEEN 2 AND 8);
ALTER TABLE public.leagues ADD COLUMN playoff_round_lengths int[];
ALTER TABLE public.league_seasons ADD COLUMN skipped_weeks int[] NOT NULL DEFAULT '{}';
ALTER TABLE public.matchups ADD COLUMN is_voided boolean NOT NULL DEFAULT false;
ALTER TABLE public.players ADD COLUMN career_regular_season_games int CHECK (career_regular_season_games >= 0);
ALTER TABLE public.players ADD COLUMN career_games_checked_at timestamptz;
ALTER TABLE public.roster_players ADD COLUMN taxi_start_season_year int;
ALTER TABLE public.trade_items ADD COLUMN to_ir boolean NOT NULL DEFAULT false CHECK (NOT to_ir OR (player_id IS NOT NULL AND NOT to_taxi));
ALTER TABLE public.trade_participants ADD COLUMN drop_player_ids uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION private.enforce_skipped_matchup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.matchup_type = 'regular_season' AND EXISTS (SELECT 1 FROM league_seasons
    WHERE id = NEW.league_season_id AND NEW.week_number = ANY(skipped_weeks)) THEN
    NEW.is_voided := true;
    NEW.is_finalized := false;
    NEW.winner_member_id := NULL;
    NEW.home_points := 0;
    NEW.away_points := 0;
    NEW.home_max_possible_points := NULL;
    NEW.away_max_possible_points := NULL;
    NEW.finalized_at := NULL;
  END IF;
  RETURN NEW;
END;
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
    v_ids := NEW.drop_player_ids;
    v_member := NEW.member_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(v_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
        AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id
        AND v_player=ANY(participant.drop_player_ids)) THEN
      RAISE EXCEPTION 'Player is reserved as a planned drop in another trade.' USING ERRCODE='PT001';
    END IF;
    IF TG_TABLE_NAME='trade_participants' THEN
      IF EXISTS (SELECT 1 FROM trade_items item JOIN trades trade ON trade.id=item.trade_id
        WHERE trade.league_id=v_trade.league_id AND trade.league_season_id=v_trade.league_season_id
          AND trade.status IN ('pending','accepted') AND trade.id<>NEW.trade_id AND item.player_id=v_player)
        OR EXISTS (SELECT 1 FROM waiver_claims WHERE league_season_id=v_trade.league_season_id
          AND status='pending' AND (drop_player_id=v_player OR player_id=v_player)) THEN
        RAISE EXCEPTION 'Planned drop is reserved by another trade or active waiver claim.' USING ERRCODE='PT001';
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

CREATE OR REPLACE FUNCTION private.guard_waiver_plan_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_player uuid;
BEGIN
  IF NEW.status<>'pending' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(NEW.member_id::text));
  FOR v_player IN SELECT DISTINCT id FROM unnest(ARRAY[NEW.player_id,NEW.drop_player_id]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(NEW.league_id::text),hashtext(v_player::text));
    IF EXISTS (SELECT 1 FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id
      WHERE trade.league_season_id=NEW.league_season_id AND trade.status IN ('pending','accepted')
        AND v_player=ANY(participant.drop_player_ids)) THEN
      RAISE EXCEPTION 'Player is reserved as a planned drop in a trade.' USING ERRCODE='PT001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.league_playoff_round_plan(p_league_id uuid, p_member_count int)
RETURNS int[] LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_league leagues%ROWTYPE; v_round_count int;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF v_league.playoff_entrants IS NULL THEN
    RETURN private.playoff_round_plan(p_member_count, v_league.playoff_total_weeks, v_league.playoff_round_weeks);
  END IF;
  IF v_league.playoff_entrants > p_member_count THEN
    RAISE EXCEPTION 'Playoff entrants (%) exceed league teams (%).', v_league.playoff_entrants, p_member_count USING ERRCODE = '22023';
  END IF;
  v_round_count := ceil(log(2, v_league.playoff_entrants))::int;
  IF cardinality(v_league.playoff_round_lengths) IS DISTINCT FROM v_round_count
     OR array_ndims(v_league.playoff_round_lengths) IS DISTINCT FROM 1
     OR array_lower(v_league.playoff_round_lengths, 1) IS DISTINCT FROM 1
     OR EXISTS (SELECT 1 FROM unnest(v_league.playoff_round_lengths) length WHERE length IS NULL OR length < 1) THEN
    RAISE EXCEPTION 'Playoffs with % entrants need % rounds. Enter positive whole weeks for each round.', v_league.playoff_entrants, v_round_count USING ERRCODE = '22023';
  END IF;
  RETURN v_league.playoff_round_lengths;
END;
$$;

CREATE OR REPLACE FUNCTION private.league_week_at_pacific(p_season_id uuid,p_reference_at timestamptz)
RETURNS int LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT week.week_number FROM league_seasons season JOIN season_weeks week ON week.season_year=season.season_year
    WHERE season.id=p_season_id
      AND (p_reference_at AT TIME ZONE 'America/Los_Angeles')::date BETWEEN week.week_start AND week.week_end;
$$;

CREATE OR REPLACE FUNCTION private.rebuild_regular_standings(p_league_id uuid, p_season_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM standings WHERE league_season_id = p_season_id;
  INSERT INTO standings(league_id, league_season_id, member_id, week_number, wins, losses, ties,
    points_for, points_against, max_possible_points, waiver_priority)
  SELECT p_league_id, p_season_id, member.id, weeks.week_number,
    count(result.id) FILTER (WHERE result.winner_member_id = member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NOT NULL AND result.winner_member_id <> member.id),
    count(result.id) FILTER (WHERE result.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_points ELSE result.away_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.away_points ELSE result.home_points END), 0),
    COALESCE(sum(CASE WHEN result.home_member_id = member.id THEN result.home_max_possible_points ELSE result.away_max_possible_points END), 0),
    COALESCE(priority.priority, 0)
  FROM league_members member
  CROSS JOIN (SELECT DISTINCT week_number FROM matchups WHERE league_season_id = p_season_id
    AND matchup_type = 'regular_season' AND is_finalized AND NOT is_voided) weeks
  LEFT JOIN matchups result ON result.league_season_id = p_season_id AND result.matchup_type = 'regular_season'
    AND result.week_number <= weeks.week_number AND result.is_finalized AND NOT result.is_voided
    AND member.id IN (result.home_member_id, result.away_member_id)
  LEFT JOIN waiver_priorities priority ON priority.league_season_id = p_season_id AND priority.member_id = member.id
  WHERE member.league_id = p_league_id
  GROUP BY member.id, weeks.week_number, priority.priority;
END;
$$;

CREATE OR REPLACE FUNCTION private.taxi_player_eligible(p_league_id uuid, p_player_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(CASE WHEN league.taxi_rule = 'rookies_or_64_games'
    THEN player.years_exp = 0 OR player.career_regular_season_games < 65
    ELSE player.years_exp = 0 AND player.nba_draft_number IS NOT NULL END, false)
  FROM leagues league CROSS JOIN players player
  WHERE league.id = p_league_id AND player.id = p_player_id;
$$;

CREATE OR REPLACE FUNCTION private.taxi_start_year(p_league_id uuid,p_player_id uuid,p_fallback int)
RETURNS int LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT COALESCE(min(start_year),p_fallback) FROM (
    SELECT COALESCE(roster.taxi_start_season_year,season.season_year) AS start_year
    FROM roster_players roster JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE roster.league_id=p_league_id AND roster.player_id=p_player_id
      AND (roster.is_on_taxi OR roster.taxi_start_season_year IS NOT NULL)
    UNION ALL
    SELECT season.season_year FROM roster_transactions history JOIN league_seasons season ON season.id=history.league_season_id
    WHERE history.league_id=p_league_id AND history.player_id=p_player_id
      AND (history.acquired_to_taxi OR history.transaction_type='taxi_designate')
  ) placements;
$$;

CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_trade trades%ROWTYPE; v_league leagues%ROWTYPE; v_team record; v_count record;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id FOR UPDATE;
  IF NOT v_league.allow_inactive_trades THEN RETURN; END IF;
  PERFORM 1 FROM players player
    WHERE player.id IN (SELECT player_id FROM trade_items WHERE trade_id=p_trade_id)
    ORDER BY player.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id
      AND member_id=item.from_member_id AND player_id=item.player_id)) THEN
    RAISE EXCEPTION 'A trade player is no longer owned by the expected team.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN players player ON player.id = item.player_id
    WHERE item.trade_id = p_trade_id AND item.to_ir AND
      (item.to_taxi OR NOT private.is_ir_designation(player.injury_status))) THEN
    RAISE EXCEPTION 'Incoming IR players must be Out or IR-designated and cannot also enter taxi.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
      ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
    WHERE item.trade_id = p_trade_id AND item.to_taxi
      AND NOT private.taxi_player_eligible(v_trade.league_id, item.player_id)) THEN
    RAISE EXCEPTION 'Incoming taxi players must be rookies or have fewer than 65 career regular-season games.' USING ERRCODE = 'PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN roster_players roster
    ON roster.league_season_id=v_trade.league_season_id AND roster.player_id=item.player_id
    JOIN league_seasons season ON season.id=roster.league_season_id
    WHERE item.trade_id=p_trade_id AND item.to_taxi AND v_league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(v_trade.league_id,roster.player_id,season.season_year)>=v_league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'Incoming taxi player has reached the taxi tenure limit.' USING ERRCODE='PT001';
  END IF;
  IF EXISTS (SELECT 1 FROM trade_items item JOIN league_member_taxi_exits exit
    ON exit.league_id=v_trade.league_id AND exit.member_id=item.to_member_id AND exit.player_id=item.player_id
    WHERE item.trade_id=p_trade_id AND item.to_taxi) THEN
    RAISE EXCEPTION 'A promoted player cannot return to this team taxi squad.' USING ERRCODE='PT001';
  END IF;
  FOR v_team IN SELECT * FROM trade_participants WHERE trade_id = p_trade_id ORDER BY member_id LOOP
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
    FROM (
      SELECT roster.is_on_ir AS on_ir, roster.is_on_taxi AS on_taxi FROM roster_players roster
      WHERE roster.league_season_id = v_trade.league_season_id AND roster.member_id = v_team.member_id
        AND NOT roster.player_id = ANY(v_team.drop_player_ids)
        AND NOT EXISTS (SELECT 1 FROM trade_items item WHERE item.trade_id = p_trade_id
          AND item.from_member_id = v_team.member_id AND item.player_id = roster.player_id)
      UNION ALL
      SELECT item.to_ir, item.to_taxi OR roster.is_on_taxi FROM trade_items item
      JOIN roster_players roster ON roster.league_season_id = v_trade.league_season_id AND roster.player_id = item.player_id
      WHERE item.trade_id = p_trade_id AND item.to_member_id = v_team.member_id
    ) resulting;
    IF v_count.total > v_league.roster_size + v_league.ir_slots + v_league.taxi_slots THEN
      RAISE EXCEPTION 'Trade exceeds the total roster limit for team %.', v_team.member_id USING ERRCODE = 'PT001';
    END IF;
    IF v_count.active > v_league.roster_size THEN
      RAISE EXCEPTION 'Trade exceeds the active roster limit for team %. Choose placements or drops.', v_team.member_id USING ERRCODE = 'PT001';
    END IF;
    IF v_count.ir > v_league.ir_slots THEN
      RAISE EXCEPTION 'Trade exceeds the IR limit for team %.', v_team.member_id USING ERRCODE = 'PT001';
    END IF;
    IF v_count.taxi > v_league.taxi_slots THEN
      RAISE EXCEPTION 'Trade exceeds the taxi limit for team %.', v_team.member_id USING ERRCODE = 'PT001';
    END IF;
  END LOOP;
END;
$$;

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
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
    END IF;
  END LOOP;

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id
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

CREATE OR REPLACE FUNCTION private.assert_taxi_acquisition_allowed(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid
)
RETURNS void LANGUAGE plpgsql SET search_path = public, private AS $$
DECLARE v_slots int; v_count int;
BEGIN
  IF EXISTS (SELECT 1 FROM league_member_taxi_exits WHERE league_id=p_league_id AND member_id=p_member_id AND player_id=p_player_id) THEN
    RAISE EXCEPTION 'This player has left your team''s taxi squad and cannot return to it, even after reacquisition or a season change.' USING ERRCODE='P0001';
  END IF;
  IF NOT private.taxi_player_eligible(p_league_id,p_player_id) THEN
    RAISE EXCEPTION 'Only current rookies can be placed on the taxi squad.' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
    WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
      AND season.season_year-private.taxi_start_year(p_league_id,p_player_id,season.season_year)>=league.taxi_max_seasons) THEN
    RAISE EXCEPTION 'This player has reached the taxi tenure limit.' USING ERRCODE='P0001';
  END IF;
  IF private.roster_status_game_started(p_player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.' USING ERRCODE='P0001';
  END IF;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=p_league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players
   WHERE league_id=p_league_id AND league_season_id=p_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count >= COALESCE(v_slots,0) AND NOT EXISTS (SELECT 1 FROM private.taxi_acquisition_context c JOIN trades t ON t.id=c.related_id WHERE c.transaction_id=pg_current_xact_id() AND c.source='trade' AND c.player_id=p_player_id AND t.status='accepted' AND EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades)) THEN
    RAISE EXCEPTION 'Your taxi squad is full (% slots).', COALESCE(v_slots,0) USING ERRCODE='P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM private.validate_trade_rosters(p_trade_id);
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

CREATE OR REPLACE FUNCTION private.can_acquire_draft_taxi(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_player_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
  SELECT EXISTS(SELECT 1 FROM leagues l WHERE l.id=p_league_id AND l.taxi_slots >
    (SELECT count(*) FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.member_id=p_member_id AND r.is_on_taxi))
  AND EXISTS(SELECT 1 FROM players p WHERE (p_player_id IS NULL OR p.id=p_player_id)
    AND (p_draft_id IS NULL OR NOT EXISTS(SELECT 1 FROM nominations n WHERE n.draft_id=p_draft_id AND n.player_id=p.id))
    AND private.taxi_player_eligible(p_league_id,p.id)
    AND NOT EXISTS (SELECT 1 FROM leagues league JOIN league_seasons season ON season.id=p_season_id
      WHERE league.id=p_league_id AND league.taxi_max_seasons IS NOT NULL
        AND season.season_year-private.taxi_start_year(p_league_id,p.id,season.season_year)>=league.taxi_max_seasons)
    AND NOT private.roster_status_game_started(p.id)
    AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits x WHERE x.league_id=p_league_id AND x.member_id=p_member_id AND x.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id=p_league_id AND r.league_season_id=p_season_id AND r.player_id=p.id));
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
  v_balance int;
  v_faab record;
  v_champion_finalized boolean := false;
BEGIN
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
   FOR UPDATE;

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

  IF v_league.status NOT IN (
    'setup'::league_status,
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

  FOR v_faab IN
    SELECT from_member_id, sum(faab_amount)::int AS amount
      FROM private.parse_multi_team_trade_items(p_items)
     WHERE faab_amount > 0
     GROUP BY from_member_id
  LOOP
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, v_faab.from_member_id);
    IF v_balance < v_faab.amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds a participant''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

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
  v_balance int;
  v_champion_finalized boolean := false;
BEGIN
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

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

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

  IF v_league.status NOT IN (
    'setup'::league_status,
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

  IF v_offer_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_proposer_member_id);
    IF v_balance < v_offer_faab_amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds the proposer''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_request_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_recipient_member_id);
    IF v_balance < v_request_faab_amount THEN
      RAISE EXCEPTION 'Requested FAAB exceeds the recipient''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
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
END;
$$;

CREATE OR REPLACE FUNCTION private.enforce_taxi_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  v_entry boolean := false;
  v_continuity boolean := false;
  v_context private.taxi_acquisition_context%ROWTYPE;
  v_year int;
  v_prior_year int;
  v_cap int;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'INSERT' THEN
      v_entry := NEW.is_on_taxi;
    ELSE
      v_entry := NEW.is_on_taxi AND (NOT OLD.is_on_taxi OR
        (OLD.league_id,OLD.league_season_id,OLD.member_id,OLD.player_id)
          IS DISTINCT FROM (NEW.league_id,NEW.league_season_id,NEW.member_id,NEW.player_id));
    END IF;
    IF TG_OP='UPDATE' AND NOT v_entry THEN NEW.taxi_start_season_year := OLD.taxi_start_season_year; END IF;
    IF v_entry THEN
      SELECT * INTO v_context FROM private.taxi_acquisition_context
       WHERE transaction_id=pg_current_xact_id() AND league_id=NEW.league_id
         AND league_season_id=NEW.league_season_id AND member_id=NEW.member_id AND player_id=NEW.player_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Players can enter taxi only through a draft or trade acquisition.' USING ERRCODE='P0001';
      END IF;
      SELECT season_year INTO v_year FROM league_seasons WHERE id=NEW.league_season_id;
      SELECT taxi_max_seasons INTO v_cap FROM leagues WHERE id=NEW.league_id;
      IF TG_OP='UPDATE' AND (OLD.is_on_taxi OR v_context.source='trade') THEN
        NEW.taxi_start_season_year := private.taxi_start_year(NEW.league_id,NEW.player_id,COALESCE(OLD.taxi_start_season_year,v_year));
      ELSIF v_context.source='carry_over' THEN
        SELECT COALESCE(taxi_start_season_year,season.season_year) INTO v_prior_year
          FROM roster_players roster JOIN league_seasons season ON season.id=roster.league_season_id
          WHERE roster.league_season_id=v_context.related_id AND roster.member_id=NEW.member_id AND roster.player_id=NEW.player_id;
        v_prior_year := private.taxi_start_year(NEW.league_id,NEW.player_id,v_prior_year);
        NEW.taxi_start_season_year := v_prior_year;
        IF v_cap IS NOT NULL AND v_year-v_prior_year >= v_cap THEN
          NEW.is_on_taxi := false;
          INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at) VALUES(NEW.league_id,NEW.member_id,NEW.player_id,now()) ON CONFLICT DO NOTHING;
        END IF;
      ELSE
        NEW.taxi_start_season_year := private.taxi_start_year(NEW.league_id,NEW.player_id,v_year);
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
      IF v_context.source='trade' AND TG_OP='UPDATE' AND OLD.is_on_taxi AND NEW.is_on_taxi THEN v_continuity := true; END IF;
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
           AND c.member_id=OLD.member_id AND r.member_id=OLD.member_id AND r.is_on_taxi)
        -- A commissioner's draft reset undoes the acquisition; the team did not move the player out.
        OR EXISTS (
        SELECT 1 FROM private.taxi_acquisition_context c
         WHERE c.transaction_id=pg_current_xact_id() AND c.source='draft_reset'
           AND c.league_id=OLD.league_id AND c.league_season_id=OLD.league_season_id
           AND c.member_id=OLD.member_id AND c.player_id=OLD.player_id);
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

CREATE OR REPLACE FUNCTION private.expire_pending_trades_for_lost_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_pick_consumed boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
  v_previous_flag text;
BEGIN
  IF p_player_id IS NOT NULL THEN
    SELECT format('%s is no longer on %s.', player.display_name, COALESCE(member.team_name, 'the offering team'))
      INTO v_reason
      FROM players AS player, league_members AS member
     WHERE player.id = p_player_id
       AND member.id = p_member_id;
  ELSE
    SELECT format(
             CASE
               WHEN p_pick_consumed THEN 'The %s round %s pick has been used in the draft.'
               ELSE 'The %s round %s pick is no longer owned by %s.'
             END,
             pick.season_year,
             pick.round,
             COALESCE(member.team_name, 'the offering team')
           )
      INTO v_reason
      FROM draft_picks AS pick, league_members AS member
     WHERE pick.id = p_pick_id
       AND member.id = p_member_id;
  END IF;

  -- This may run inside an authenticated user's transaction (a drop expiring
  -- an offer); the status guard trusts server-owned lifecycle work.
  v_previous_flag := private.begin_trade_lifecycle_write();

  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status,
           completion_failure_reason = v_reason
     WHERE trade.league_id = p_league_id
       AND trade.status = 'pending'::trade_status
       AND (EXISTS (
         SELECT 1
           FROM trade_items AS item
          WHERE item.trade_id = trade.id
            AND item.from_member_id = p_member_id
            AND (
              (p_player_id IS NOT NULL AND item.player_id = p_player_id)
              OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
            )
       ) OR EXISTS (SELECT 1 FROM trade_participants participant WHERE participant.trade_id=trade.id AND participant.member_id=p_member_id AND p_player_id=ANY(participant.drop_player_ids)))
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  )
  -- The reason stays on the trade (visible to its parties); the league-wide
  -- activity row names no asset of a pending offer.
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_trade_id,
    event_type,
    title
  )
  SELECT
    expired.league_id,
    expired.league_season_id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    expired.id,
    'trade_expired',
    'Trade offer expired'
    FROM expired;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
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
      AND participant.member_id=p_member_id AND p_player_id=ANY(participant.drop_player_ids))
$$;

CREATE OR REPLACE FUNCTION private.playoff_seed_rankings(
  p_league_id uuid,
  p_league_season_id uuid,
  p_playoff_start_week int
)
RETURNS TABLE (
  member_id uuid,
  wins bigint,
  points_for numeric,
  max_possible_points numeric,
  points_against numeric,
  tie_token text,
  seed_rank bigint,
  group_start bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH member_stats AS (
    SELECT
      member.id AS member_id,
      count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_points
        ELSE 0
      END), 0) AS points_for,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
        ELSE 0
      END), 0) AS max_possible_points,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.away_points
        WHEN matchup.away_member_id = member.id THEN matchup.home_points
        ELSE 0
      END), 0) AS points_against,
      encode(extensions.digest((p_league_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
    FROM public.league_members AS member
    LEFT JOIN public.matchups AS matchup
      ON matchup.league_season_id = p_league_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < p_playoff_start_week
     AND matchup.is_finalized = true AND NOT matchup.is_voided
     AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    WHERE member.league_id = p_league_id
    GROUP BY member.id
  ),
  ranked AS (
    SELECT
      member_stats.*,
      row_number() OVER (
        ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC
      ) AS seed_rank
    FROM member_stats
  )
  SELECT
    ranked.*,
    min(seed_rank) OVER (
      PARTITION BY wins, points_for, max_possible_points, points_against
    ) AS group_start
  FROM ranked;
$$;

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

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id, NULL, CASE WHEN private.trade_lifecycle_write_active() THEN (SELECT participant.trade_id FROM trade_participants participant JOIN trades trade ON trade.id=participant.trade_id WHERE trade.status='accepted' AND trade.league_season_id=OLD.league_season_id AND participant.member_id=OLD.member_id AND OLD.player_id=ANY(participant.drop_player_ids)) ELSE NULL END);

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION private.regular_season_matchup_payload(p_league_id uuid, p_season_id uuid, p_weeks int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_members uuid[];
  v_count int;
  v_round int;
  v_week int;
  v_pair int;
  v_home uuid;
  v_away uuid;
  v_played int := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT array_agg(id ORDER BY joined_at, id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
  v_count := COALESCE(cardinality(v_members), 0);
  IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
  IF v_count % 2 = 1 THEN
    v_members := array_append(v_members, NULL::uuid);
    v_count := v_count + 1;
  END IF;
  -- Same fixed-team rotation as roundRobinRounds in matchupGeneration.ts.
  FOR v_week IN 1..p_weeks LOOP
    IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
    v_round := v_played % (v_count - 1);
    v_played := v_played + 1;
    FOR v_pair IN 0..(v_count / 2 - 1) LOOP
      v_home := CASE WHEN v_pair = 0 THEN v_members[1] ELSE v_members[2 + (v_pair - 1 + v_round) % (v_count - 1)] END;
      v_away := v_members[2 + (v_count - 2 - v_pair + v_round) % (v_count - 1)];
      IF v_home IS NOT NULL AND v_away IS NOT NULL THEN
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'league_id', p_league_id, 'league_season_id', p_season_id,
          'week_number', v_week, 'matchup_type', 'regular_season',
          'home_member_id', v_home, 'away_member_id', v_away));
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
BEGIN
  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  -- An old-season row going away never touches live state.
  IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id = OLD.league_season_id AND is_current = true) THEN
    RETURN NULL;
  END IF;


  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND member_id = OLD.member_id
     AND player_id = OLD.player_id;

  IF v_left_roster THEN
    WITH changed_claims AS (UPDATE waiver_claims
       SET status = CASE WHEN EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades) THEN 'cancelled'::waiver_claim_status ELSE status END,
           failure_reason = CASE WHEN EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades) THEN 'The selected drop player left this roster in another transaction.' ELSE failure_reason END,
           processed_at = CASE WHEN EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades) THEN now() ELSE processed_at END,
           drop_player_id = NULL
     WHERE status = 'pending'::waiver_claim_status
       AND league_id = OLD.league_id
       AND league_season_id = OLD.league_season_id
       AND member_id = OLD.member_id
       AND drop_player_id = OLD.player_id
     RETURNING id,member_id,failure_reason,status)
    INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
    SELECT 'trade_claim_cancelled:'||id,id_member,'trade_claim_cancelled','Waiver claim cancelled',failure_reason,
      jsonb_build_object('claimId',id),'trade'
    FROM (SELECT id,member_id AS id_member,failure_reason FROM changed_claims WHERE status='cancelled') cancelled
    WHERE private.trade_lifecycle_write_active()
    ON CONFLICT (dedupe_key) DO NOTHING;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.set_trade_roster_plan_atomic(p_trade_id,p_member_id,p_user_id,p_taxi_player_ids,p_ir_player_ids,p_drop_player_ids);
  RETURN public.accept_trade_atomic(p_trade_id,p_member_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_rounds int[];
  v_next_start int;
  v_next_end int;
  v_quarterfinal_count int;
  v_quarterfinal_week int;
  v_quarterfinal_winners uuid[];
  v_quarterfinals_ready boolean;
  v_semifinal_count int;
  v_semifinal_week int;
  v_semifinal_winners uuid[];
  v_semifinals_ready boolean;
  v_seed_ids uuid[];
  v_branches uuid[];
  v_seed int;
  v_byes int;
  v_winner uuid;
  v_inserted_count int := 0;
BEGIN
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, playoff_round_weeks, playoff_seed_member_ids INTO v_season_id, v_season_year, v_rounds, v_seed_ids
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff advancement.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_final'::public.matchup_type
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  SELECT count(*), min(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_quarterfinal_count, v_quarterfinal_week, v_quarterfinal_winners, v_quarterfinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_quarterfinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS quarterfinals;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
   FOR UPDATE;

  IF v_quarterfinal_count > 0 AND NOT FOUND THEN
    IF v_quarterfinals_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Quarterfinals are not yet finalized.';
    END IF;

    PERFORM 1
      FROM public.matchups AS matchup
     WHERE matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'regular_season'::public.matchup_type
       AND matchup.week_number < v_quarterfinal_week
       AND matchup.is_finalized = true
     FOR UPDATE;

    IF v_seed_ids IS NULL THEN
      RAISE EXCEPTION 'Original playoff seed order is missing. Semifinals cannot be generated until verified original seeds are restored. Existing results are unchanged.';
    END IF;

    v_branches := array_fill(NULL::uuid,ARRAY[4]);
    v_byes := 8-cardinality(v_seed_ids);
    FOR v_seed IN 1..4 LOOP
      IF v_seed<=v_byes THEN
        v_branches[v_seed] := v_seed_ids[v_seed];
      ELSE
        SELECT winner_member_id INTO v_winner FROM public.matchups
          WHERE league_season_id=v_season_id AND matchup_type='playoff_quarterfinal'
            AND home_member_id=v_seed_ids[v_seed];
        v_branches[v_seed] := v_winner;
      END IF;
    END LOOP;

    SELECT max(COALESCE(end_week_number, week_number)) + 1 INTO v_next_start
      FROM public.matchups WHERE league_season_id = v_season_id AND matchup_type = 'playoff_quarterfinal';
    v_next_end := v_next_start + COALESCE(v_rounds[2], 1) - 1;
    PERFORM private.assert_playoff_window(v_season_year, v_next_start, ARRAY[COALESCE(v_rounds[2], 1), COALESCE(v_rounds[3], 1)]);

    WITH inserted AS (
      INSERT INTO public.matchups (
        league_id,
        league_season_id,
        week_number,
        end_week_number,
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_branches[1], v_branches[4]),
        (p_league_id, v_season_id, v_next_start, v_next_end, 'playoff_semifinal'::public.matchup_type, v_branches[2], v_branches[3])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;

    RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
  END IF;

  SELECT count(*), max(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_semifinal_count, v_semifinal_week, v_semifinal_winners, v_semifinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS semifinals;

  IF v_semifinal_count < (CASE WHEN cardinality(v_seed_ids)=3 THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'Semifinals not found.';
  END IF;

  IF v_semifinals_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Semifinals are not yet finalized.';
  END IF;

  IF cardinality(v_seed_ids)=3 THEN
    v_semifinal_winners := ARRAY[v_seed_ids[1],v_semifinal_winners[1]];
  END IF;
  SELECT max(COALESCE(end_week_number, week_number)) + 1 INTO v_next_start
    FROM public.matchups WHERE league_season_id = v_season_id AND matchup_type = 'playoff_semifinal';
  v_next_end := v_next_start + COALESCE(v_rounds[cardinality(v_rounds)], 1) - 1;
  PERFORM private.assert_playoff_window(v_season_year, v_next_start, ARRAY[COALESCE(v_rounds[cardinality(v_rounds)], 1)]);

  WITH inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      end_week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    VALUES (
      p_league_id,
      v_season_id,
      v_next_start,
      v_next_end,
      'playoff_final'::public.matchup_type,
      v_semifinal_winners[1],
      v_semifinal_winners[2]
    )
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted_count FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
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
    taxi_start_season_year,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
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

  INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
  SELECT current.league_id,current.league_season_id,current.member_id,current.player_id,'taxi_return',current.acquired_at+interval '1 millisecond'
  FROM roster_players current JOIN roster_players previous ON previous.league_season_id=v_current_season.id
    AND previous.member_id=current.member_id AND previous.player_id=current.player_id
  WHERE current.league_season_id=v_new_season_id AND previous.is_on_taxi AND NOT current.is_on_taxi;

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

CREATE OR REPLACE FUNCTION public.apply_season_boundary_after_grace(
  p_league_id uuid,
  p_league_season_id uuid,
  p_action text,
  p_reference_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start int;
  v_year int;
  v_type matchup_type;
  v_count int;
  v_ready boolean;
  v_latest timestamptz;
  v_result jsonb;
  v_next record;
  v_week int;
  v_input_token jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('generate', 'advance', 'rollover') OR p_reference_at IS NULL THEN
    RAISE EXCEPTION 'Invalid automatic season boundary request.' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT COALESCE(season.playoff_start_week, league.playoff_start_week, 20), season.season_year INTO v_start, v_year
    FROM public.league_seasons season JOIN public.leagues league ON league.id = season.league_id
    WHERE season.id = p_league_season_id AND season.league_id = p_league_id AND season.is_current
    FOR UPDATE OF season;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied', false); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = p_league_season_id ORDER BY id FOR UPDATE;

  IF p_action = 'generate' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type <> 'regular_season') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    v_type := 'regular_season';
  ELSIF p_action = 'advance' THEN
    IF EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_final') THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
    v_type := CASE WHEN EXISTS(SELECT 1 FROM public.matchups WHERE league_season_id = p_league_season_id AND matchup_type = 'playoff_semifinal')
      THEN 'playoff_semifinal'::matchup_type ELSE 'playoff_quarterfinal'::matchup_type END;
  ELSE
    v_type := 'playoff_final';
  END IF;

  SELECT count(*), bool_and(is_finalized IS TRUE AND (v_type = 'regular_season' OR winner_member_id IS NOT NULL)), max(finalized_at)
    INTO v_count, v_ready, v_latest
    FROM public.matchups WHERE league_season_id = p_league_season_id AND NOT is_voided AND matchup_type = v_type
      AND (v_type <> 'regular_season' OR week_number < v_start);
  IF NOT (p_action = 'generate' AND v_start = 1) AND
      (v_count = 0 OR v_ready IS DISTINCT FROM true OR v_latest > p_reference_at - interval '48 hours') THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  -- Keep input revisions locked through the transition. Missing legacy
  -- certificates require an actual replay, never a timestamp backfill.
  FOR v_week IN SELECT DISTINCT week_number FROM public.matchups
      WHERE league_season_id = p_league_season_id AND NOT is_voided
        AND (matchup_type = v_type OR (p_action = 'rollover' AND matchup_type = 'regular_season'))
        AND (matchup_type <> 'regular_season' OR week_number < v_start) ORDER BY week_number LOOP
    SELECT input_token INTO v_input_token FROM private.score_week_certificates
      WHERE league_season_id = p_league_season_id AND week_number = v_week;
    IF NOT private.lock_current_score_inputs(p_league_season_id, v_week, v_input_token) THEN
      RETURN jsonb_build_object('applied', false);
    END IF;
  END LOOP;

  IF p_action = 'generate' THEN
    v_result := public.generate_playoff_bracket_atomic(p_league_id);
    UPDATE public.leagues SET status = 'playoffs' WHERE id = p_league_id AND status = 'active';
  ELSIF p_action = 'advance' THEN
    v_result := public.advance_playoff_bracket_atomic(p_league_id);
  ELSE
    SELECT * INTO v_next FROM public.advance_season_atomic(p_league_id);
    RETURN jsonb_build_object('applied', true, 'new_season_id', v_next.new_season_id, 'new_year', v_next.new_year);
  END IF;
  RETURN jsonb_build_object('applied', COALESCE((v_result->>'inserted')::int, 0) > 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_ineligible_taxi_players()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_candidate record;
  v_active_count integer;
  v_roster_size integer;
  v_rows integer;
BEGIN
  v_count := 0;

  FOR v_candidate IN
    SELECT rp.id AS roster_player_id,
           rp.league_id,
           rp.league_season_id,
           rp.member_id,
           rp.player_id
      FROM roster_players AS rp
      JOIN players AS p
        ON p.id = rp.player_id
      JOIN league_seasons AS season
        ON season.id = rp.league_season_id
       AND season.is_current = true
      JOIN leagues AS league
        ON league.id = rp.league_id
       AND league.status IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     WHERE rp.is_on_taxi = true
       AND (
         NOT private.taxi_player_eligible(rp.league_id,p.id)
       )
     ORDER BY rp.league_id, rp.member_id, rp.player_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_candidate.league_id::text),
      hashtext(v_candidate.member_id::text)
    );

    PERFORM pg_advisory_xact_lock(
      hashtext(v_candidate.league_id::text),
      hashtext(v_candidate.player_id::text)
    );

    PERFORM 1
      FROM roster_players AS rp
      JOIN players AS p
        ON p.id = rp.player_id
     WHERE rp.id = v_candidate.roster_player_id
       AND rp.is_on_taxi = true
       AND (
         NOT private.taxi_player_eligible(rp.league_id,p.id)
       )
     FOR UPDATE OF rp;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT league.roster_size
      INTO v_roster_size
      FROM leagues AS league
     WHERE league.id = v_candidate.league_id
       AND league.status IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM 1
      FROM league_seasons AS season
     WHERE season.id = v_candidate.league_season_id
       AND season.is_current = true
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE league_id = v_candidate.league_id
       AND league_season_id = v_candidate.league_season_id
       AND member_id = v_candidate.member_id
       AND is_on_ir = false
       AND is_on_taxi = false;

    IF v_active_count >= COALESCE(v_roster_size, 0) THEN
      CONTINUE;
    END IF;

    UPDATE roster_players
       SET is_on_taxi = false
     WHERE id = v_candidate.roster_player_id
       AND is_on_taxi = true;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END LOOP;

  RETURN v_count;
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
  v_drop record;
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
  IF v_league.allow_inactive_trades THEN
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  END IF;

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
        IF NOT v_item.to_taxi THEN RAISE; END IF;
        -- A game in progress only delays a taxi destination: keep the accepted trade for a later run.
        IF SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PT002';
        END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION 'Taxi acquisition failed: %', SQLERRM USING ERRCODE='PT001';
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
  v_user_id      uuid := (SELECT auth.uid());
  v_slug         text;
  v_invite_code  text;
  v_league_id    uuid;
  v_member_id    uuid;
  v_season_id    uuid;
  v_season_year  int;
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_auction_budget IS NULL OR p_auction_budget <= 0 THEN
    RAISE EXCEPTION 'auction_budget must be a positive integer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    SELECT lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]', '', 'g'))
      INTO v_email_prefix
      FROM auth.users
     WHERE id = v_user_id;

    v_email_prefix := COALESCE(NULLIF(v_email_prefix, ''), 'user');
    IF length(v_email_prefix) < 3 THEN v_email_prefix := 'user'; END IF;
    v_username := v_email_prefix;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
      v_counter := v_counter + 1;
      v_username := v_email_prefix || v_counter::text;
      IF v_counter > 999 THEN EXIT; END IF;
    END LOOP;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES (v_user_id, v_username, v_email_prefix)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  v_season_year := private.setup_season_year_et();
  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
            || '-' || substring(gen_random_uuid()::text, 1, 4);
  v_invite_code := public.generate_invite_code();

  INSERT INTO public.leagues (name, slug, invite_code, commissioner_id, auction_budget, playoff_start_week)
  VALUES (trim(p_name), v_slug, v_invite_code, v_user_id, p_auction_budget, 17)
  RETURNING id INTO v_league_id;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league_id, v_user_id, 'commissioner', trim(p_team_name))
  RETURNING id INTO v_member_id;

  INSERT INTO public.league_seasons (league_id, season_year, is_current)
  VALUES (v_league_id, v_season_year, true)
  RETURNING id INTO v_season_id;

  -- Waiver claims process only for members with a waiver spot; joiners line
  -- up behind the commissioner.
  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league_id, v_season_id, v_member_id, 1);

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

CREATE OR REPLACE FUNCTION public.finalize_score_week_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb,
  p_standings jsonb,
  p_finalized_at timestamptz DEFAULT now(),
  p_reconciliation_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_count int;
  v_distinct_count int;
  v_locked_count int;
  v_notifications jsonb := '[]'::jsonb;
  v_input_token jsonb;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_standings IS NULL OR jsonb_typeof(p_standings) <> 'array' THEN
    RAISE EXCEPTION 'p_standings must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT requested.id)
    INTO v_requested_count, v_distinct_count
    FROM jsonb_to_recordset(p_matchups) AS requested(
      id uuid,
      winner_member_id uuid,
      home_max_possible_points numeric,
      away_max_possible_points numeric
    );

  IF v_requested_count = 0 THEN
    RETURN v_notifications;
  END IF;

  IF v_distinct_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains duplicate matchup ids.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN '[]'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  v_input_token := p_matchups->0->'input_token';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_matchups) item WHERE item->'input_token' IS DISTINCT FROM v_input_token)
      OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token) THEN
    RAISE EXCEPTION 'Score inputs changed or were not certified. Retry scoring.' USING ERRCODE = 'PT409';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz,
        reconcile_decision boolean
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at,
      requested.reconcile_decision AS requested_reconcile_decision
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  )
  SELECT count(*)
    INTO v_locked_count
    FROM locked;

  IF v_locked_count <> v_requested_count THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.'
      USING ERRCODE = '22023';
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        id uuid,
        winner_member_id uuid,
        home_points numeric,
        away_points numeric,
        home_max_possible_points numeric,
        away_max_possible_points numeric,
        score_read_started_at timestamptz,
        reconcile_decision boolean
      )
  ),
  locked AS (
    SELECT
      matchup.*,
      requested.winner_member_id AS requested_winner_member_id,
      requested.home_points AS requested_home_points,
      requested.away_points AS requested_away_points,
      requested.home_max_possible_points AS requested_home_max_possible_points,
      requested.away_max_possible_points AS requested_away_max_possible_points,
      requested.score_read_started_at AS requested_score_read_started_at,
      requested.reconcile_decision AS requested_reconcile_decision
    FROM public.matchups AS matchup
    JOIN requested
      ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id
      AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    FOR UPDATE
  ),
  updated AS (
    UPDATE public.matchups AS matchup
       SET winner_member_id = locked.requested_winner_member_id,
           home_points = COALESCE(locked.requested_home_points, locked.home_points),
           away_points = COALESCE(locked.requested_away_points, locked.away_points),
           home_max_possible_points = locked.requested_home_max_possible_points,
           away_max_possible_points = locked.requested_away_max_possible_points,
           is_finalized = true,
           score_read_started_at = COALESCE(locked.requested_score_read_started_at, p_finalized_at),
           finalized_at = CASE
             WHEN locked.is_finalized IS FALSE THEN p_finalized_at
             WHEN locked.matchup_type IN (
               'playoff_quarterfinal'::matchup_type,
               'playoff_semifinal'::matchup_type,
               'playoff_final'::matchup_type
             ) AND (locked.winner_member_id IS DISTINCT FROM locked.requested_winner_member_id
               OR locked.home_max_possible_points IS DISTINCT FROM locked.requested_home_max_possible_points
               OR locked.away_max_possible_points IS DISTINCT FROM locked.requested_away_max_possible_points) THEN p_reconciliation_at
             ELSE matchup.finalized_at
           END
      FROM locked
     WHERE matchup.id = locked.id
       AND NOT private.playoff_round_is_consumed(p_league_season_id, locked.matchup_type)
     RETURNING
       matchup.id,
       locked.is_finalized AS was_finalized,
       matchup.home_member_id,
       matchup.away_member_id,
       matchup.home_points,
       matchup.away_points,
       matchup.winner_member_id
  ),
  notification_rows AS (
    SELECT *
      FROM updated
     WHERE was_finalized IS FALSE
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'home_member_id', home_member_id,
        'away_member_id', away_member_id,
        'home_points', home_points,
        'away_points', away_points,
        'winner_member_id', winner_member_id
      )
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_notifications
    FROM notification_rows;

  INSERT INTO public.standings (
    league_id,
    league_season_id,
    member_id,
    week_number,
    created_at,
    wins,
    losses,
    ties,
    points_for,
    points_against,
    max_possible_points,
    waiver_priority
  )
  SELECT
    p_league_id,
    p_league_season_id,
    standing.member_id,
    p_week_number,
    COALESCE(standing.created_at, p_finalized_at),
    standing.wins,
    standing.losses,
    standing.ties,
    standing.points_for,
    standing.points_against,
    standing.max_possible_points,
    standing.waiver_priority
  FROM jsonb_to_recordset(p_standings) AS standing(
    member_id uuid,
    created_at timestamptz,
    wins int,
    losses int,
    ties int,
    points_for numeric,
    points_against numeric,
    max_possible_points numeric,
    waiver_priority int
  )
  ON CONFLICT (league_id, league_season_id, member_id, week_number)
  DO UPDATE SET
    created_at = EXCLUDED.created_at,
    wins = EXCLUDED.wins,
    losses = EXCLUDED.losses,
    ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for,
    points_against = EXCLUDED.points_against,
    max_possible_points = EXCLUDED.max_possible_points,
    waiver_priority = EXCLUDED.waiver_priority;

  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND cardinality(skipped_weeks)>0) THEN
    PERFORM private.rebuild_regular_standings(p_league_id,p_league_season_id);
  END IF;

  INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
    VALUES(p_league_season_id, p_week_number, private.score_input_token(p_league_season_id, p_week_number))
    ON CONFLICT(league_season_id, week_number) DO UPDATE SET input_token = EXCLUDED.input_token;

  RETURN v_notifications;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_playoff_start_week int;
  v_member_count int;
  v_playoff_size int;
  v_rounds int[];
  v_league public.leagues%ROWTYPE;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_pair record;
  v_seed int;
  v_size int;
  v_type public.matchup_type;
  v_existing_challenge public.rps_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, COALESCE(playoff_start_week, v_league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type <> 'regular_season'
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false AND NOT matchup.is_voided
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Regular season matchups must be finalized before generating playoffs.';
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
   FOR UPDATE;

  SELECT count(*)
    INTO v_member_count
    FROM public.league_members AS member
   WHERE member.league_id = p_league_id;

  IF v_member_count < COALESCE(v_league.playoff_entrants,4) THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need 4).';
  END IF;

  v_playoff_size := COALESCE(v_league.playoff_entrants,CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END);

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_season_year, v_playoff_start_week, v_rounds);
  UPDATE public.league_seasons
     SET playoff_start_week = v_playoff_start_week, playoff_round_weeks = v_rounds
   WHERE id = v_season_id;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

  UPDATE public.league_seasons SET playoff_seed_member_ids = v_seed_ids[1:v_playoff_size]
    WHERE id = v_season_id;

  FOR v_pair IN
    SELECT
      a.member_id AS member_a_id,
      b.member_id AS member_b_id,
      CASE
        WHEN a.tie_token < b.tie_token OR (a.tie_token = b.tie_token AND a.member_id < b.member_id) THEN a.member_id
        ELSE b.member_id
      END AS winner_member_id
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS a
    JOIN private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS b
      ON b.seed_rank > a.seed_rank
     AND b.wins = a.wins
     AND b.points_for = a.points_for
     AND b.max_possible_points = a.max_possible_points
     AND b.points_against = a.points_against
    WHERE a.group_start <= v_playoff_size
  LOOP
    SELECT *
      INTO v_existing_challenge
      FROM public.rps_challenges AS challenge
     WHERE challenge.league_id = p_league_id
       AND challenge.league_season_id = v_season_id
       AND challenge.context = 'standings_playoff_tiebreaker'
       AND LEAST(challenge.member_a_id, challenge.member_b_id) = LEAST(v_pair.member_a_id, v_pair.member_b_id)
       AND GREATEST(challenge.member_a_id, challenge.member_b_id) = GREATEST(v_pair.member_a_id, v_pair.member_b_id)
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.rps_challenges
         SET winner_member_id = v_pair.winner_member_id,
             member_a_choice = NULL,
             member_b_choice = NULL,
             status = 'completed'::public.rps_status,
             resolved_at = now()
       WHERE id = v_existing_challenge.id;
    ELSE
      INSERT INTO public.rps_challenges (
        league_id,
        league_season_id,
        member_a_id,
        member_b_id,
        winner_member_id,
        status,
        context,
        resolved_at
      )
      VALUES (
        p_league_id,
        v_season_id,
        v_pair.member_a_id,
        v_pair.member_b_id,
        v_pair.winner_member_id,
        'completed'::public.rps_status,
        'standings_playoff_tiebreaker',
        now()
      );
    END IF;
  END LOOP;

  v_size := power(2,cardinality(v_rounds))::int;
  v_type := CASE cardinality(v_rounds) WHEN 3 THEN 'playoff_quarterfinal'::public.matchup_type
    WHEN 2 THEN 'playoff_semifinal'::public.matchup_type ELSE 'playoff_final'::public.matchup_type END;
  FOR v_seed IN 1..(v_size/2) LOOP
    IF v_size+1-v_seed <= v_playoff_size THEN
      INSERT INTO public.matchups(league_id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id)
      VALUES(p_league_id,v_season_id,v_playoff_start_week,v_playoff_start_week+v_rounds[1]-1,v_type,
        v_seed_ids[v_seed],v_seed_ids[v_size+1-v_seed])
      ON CONFLICT (league_id,league_season_id,week_number,home_member_id,away_member_id) DO NOTHING;
      v_inserted_count := v_inserted_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',v_inserted_count,'skipped',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(p_league_season_id uuid, p_through_week int)
RETURNS TABLE(week_number int) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT matchup.week_number
  FROM public.matchups matchup
  LEFT JOIN private.score_week_certificates certificate
    ON certificate.league_season_id = matchup.league_season_id AND certificate.week_number = matchup.week_number
  WHERE matchup.league_season_id = p_league_season_id AND matchup.week_number <= p_through_week
    AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id)
    AND matchup.is_finalized IS TRUE AND NOT matchup.is_voided
    AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
    AND (certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token(p_league_season_id, matchup.week_number))
  ORDER BY matchup.week_number;
$$;

CREATE OR REPLACE FUNCTION public.join_league_by_invite_code(p_invite_code text, p_team_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_league           public.leagues%ROWTYPE;
  v_user_id          uuid := (SELECT auth.uid());
  v_invite_code      text := upper(trim(coalesce(p_invite_code, '')));
  v_existing         uuid;
  v_member_id        uuid;
  v_member_count     int;
  v_league_season_id uuid;
  v_season_year      int;
  v_priority         int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_invite_code !~ '^[A-Z0-9]{16}$' THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  SELECT *
  INTO   v_league
  FROM   public.leagues
  WHERE  invite_code = v_invite_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found. Check your invite code.';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::public.league_status THEN
    RAISE EXCEPTION 'This league is no longer accepting new members.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO   v_existing
  FROM   public.league_members
  WHERE  league_id = v_league.id
    AND  user_id   = v_user_id;

  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  PERFORM v_existing;

  SELECT count(*)
  INTO   v_member_count
  FROM   public.league_members
  WHERE  league_id = v_league.id;

  IF v_member_count >= v_league.team_limit THEN
    RAISE EXCEPTION 'This league is full.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, season_year
  INTO   v_league_season_id, v_season_year
  FROM   public.league_seasons
  WHERE  league_id = v_league.id
    AND  is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League has no active season.';
  END IF;

  INSERT INTO public.league_members (league_id, user_id, role, team_name)
  VALUES (v_league.id, v_user_id, 'manager', trim(p_team_name))
  RETURNING id INTO v_member_id;

  SELECT COALESCE(max(wp.priority), 0) + 1
  INTO   v_priority
  FROM   public.waiver_priorities AS wp
  WHERE  wp.league_id = v_league.id
    AND  wp.league_season_id = v_league_season_id;

  INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
  VALUES (v_league.id, v_league_season_id, v_member_id, v_priority);

  INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
  SELECT v_league.id, year_value, round_value, v_member_id, v_member_id
  FROM generate_series(v_season_year + 1, v_season_year + 5) AS year_value
  CROSS JOIN generate_series(1, 3) AS round_value
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  RETURN jsonb_build_object(
    'id',     v_league.id,
    'name',   v_league.name,
    'status', v_league.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season public.league_seasons%ROWTYPE;
  v_rounds int[];
  v_members int;
  v_had_schedule boolean;
  v_had_bracket boolean;
BEGIN
  -- The league UPDATE already holds the first lock. Every schedule writer
  -- takes league, season, advisory locks, then matchup rows in that order.
  SELECT * INTO v_season FROM public.league_seasons
   WHERE league_id = NEW.id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found. Playoff settings were not changed.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(v_season.id::text));
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season.id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = v_season.id FOR UPDATE;
  v_had_schedule := FOUND;
  SELECT EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id = v_season.id AND matchup_type <> 'regular_season') INTO v_had_bracket;
  PERFORM private.assert_schedule_not_started(v_season.id);
  SELECT count(*) INTO v_members FROM public.league_members WHERE league_id = NEW.id;
  v_rounds := private.league_playoff_round_plan(NEW.id, v_members);
  PERFORM private.assert_playoff_window(v_season.season_year, NEW.playoff_start_week, v_rounds, true);
  UPDATE public.league_seasons
     SET playoff_start_week = NEW.playoff_start_week, playoff_round_weeks = NULL, playoff_seed_member_ids = NULL
   WHERE id = v_season.id;
  IF v_had_schedule THEN
    DELETE FROM public.matchups WHERE league_season_id = v_season.id;
    -- A changed future schedule gets fresh standings tie evidence at seeding.
    DELETE FROM public.rps_challenges WHERE league_season_id = v_season.id AND context = 'standings_playoff_tiebreaker';
    PERFORM public.replace_regular_season_matchups_atomic(NEW.id, v_season.id, false,
      private.regular_season_matchup_payload(NEW.id, v_season.id, NEW.playoff_start_week - 1));
    IF v_had_bracket AND NEW.playoff_start_week = 1 THEN
      PERFORM public.generate_playoff_bracket_atomic(NEW.id);
    ELSIF v_had_bracket AND NEW.status = 'playoffs' THEN
      UPDATE public.leagues SET status = 'active' WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_regular_season_matchups_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_force boolean DEFAULT false,
  p_matchups jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_count int;
  v_start int;
  v_year int;
  v_league public.leagues%ROWTYPE;
  v_rounds int[];
  v_member_count int;
  v_inserted_count int := 0;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.';
  END IF;

  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  v_start := v_league.playoff_start_week;

  SELECT season.season_year INTO v_year
    FROM public.league_seasons AS season
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for matchup generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(p_league_season_id::text));

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     WHERE requested.league_id IS DISTINCT FROM p_league_id
        OR requested.league_season_id IS DISTINCT FROM p_league_season_id
        OR requested.week_number IS NULL
        OR requested.week_number < 1
        OR requested.week_number >= v_start
        OR requested.matchup_type IS DISTINCT FROM 'regular_season'
        OR requested.home_member_id IS NULL
        OR requested.away_member_id IS NULL
        OR requested.home_member_id = requested.away_member_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.home_member_id
             AND member.league_id = p_league_id
        )
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.away_member_id
             AND member.league_id = p_league_id
        )
  ) THEN
    RAISE EXCEPTION 'p_matchups contains invalid regular-season rows.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     GROUP BY
        requested.league_id,
        requested.league_season_id,
        requested.week_number,
        requested.matchup_type,
        LEAST(requested.home_member_id::text, requested.away_member_id::text),
        GREATEST(requested.home_member_id::text, requested.away_member_id::text)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matchups contains duplicate weekly pairings.';
  END IF;

  SELECT count(*) INTO v_member_count FROM public.league_members WHERE league_id = p_league_id;
  IF v_member_count >= 2 AND p_matchups IS DISTINCT FROM private.regular_season_matchup_payload(p_league_id,p_league_season_id,v_start-1) AND (
    (SELECT count(DISTINCT (value->>'week_number')::int) FROM jsonb_array_elements(p_matchups)) <> v_start - 1
    OR jsonb_array_length(p_matchups) <> (v_start - 1)::bigint * (v_member_count / 2)
  ) THEN
    RAISE EXCEPTION 'The proposed regular schedule does not match the saved playoff start. Reload settings and retry.';
  END IF;

  SELECT count(*)
    INTO v_existing_count
    FROM public.matchups
   WHERE league_season_id = p_league_season_id;

  IF v_existing_count > 0 AND p_force IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_year, v_start, v_rounds, true);

  IF v_existing_count > 0 THEN
    PERFORM private.assert_schedule_not_started(p_league_season_id);
    IF EXISTS (
      SELECT 1
        FROM public.matchups
       WHERE league_season_id = p_league_season_id
         AND (
           is_finalized = true
           OR matchup_type IN (
             'playoff_quarterfinal'::public.matchup_type,
             'playoff_semifinal'::public.matchup_type,
             'playoff_final'::public.matchup_type
           )
         )
    ) THEN
      RAISE EXCEPTION 'Cannot force-regenerate matchups after finalized or playoff matchups exist.';
    END IF;

    DELETE FROM public.matchups
     WHERE league_season_id = p_league_season_id;
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(private.regular_season_matchup_payload(p_league_id,p_league_season_id,v_start-1)) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
  ),
  inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    SELECT
      requested.league_id,
      requested.league_season_id,
      requested.week_number,
      requested.matchup_type::public.matchup_type,
      requested.home_member_id,
      requested.away_member_id
    FROM requested
    WHERE NOT EXISTS (SELECT 1 FROM league_seasons WHERE id=p_league_season_id AND requested.week_number=ANY(skipped_weeks))
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*)
    INTO v_inserted_count
    FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[]
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
  IF NOT EXISTS (SELECT 1 FROM leagues WHERE id = v_trade.league_id AND allow_inactive_trades) THEN
    RAISE EXCEPTION 'Enable IR and taxi trades in league settings first.';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids;
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
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids WHERE trade_id = p_trade_id AND member_id = p_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated',
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_budget_per_team int DEFAULT NULL,
  p_timer_expiry_behavior text DEFAULT 'auction_no_bid'
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
  v_budget int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_timer_expiry_behavior, 'auction_no_bid') <> 'auction_no_bid' THEN
    RAISE EXCEPTION 'Auction drafts use auction_no_bid timeout behavior.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  v_budget := COALESCE(p_budget_per_team, v_league.auction_budget);
  IF v_budget IS NULL OR v_budget <= 0 THEN
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

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
       AND is_mock = false
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

  IF NOT v_is_mock THEN
    PERFORM private.league_playoff_round_plan(v_league.id, v_member_count);
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    started_at,
    current_nomination_order,
    nomination_order_mode,
    is_mock,
    pick_timer_seconds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_budget,
    now(),
    1,
    p_nomination_order_mode,
    v_is_mock,
    p_pick_timer_seconds,
    'auction_no_bid'
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_budget, v_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id;
  END IF;

  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
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
  v_is_mock boolean := COALESCE(p_is_mock, false);
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  IF p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
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
       AND pick.season_year = v_season.season_year
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
    timer_expiry_behavior
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
    v_timer_expiry_behavior
  )
  RETURNING * INTO v_draft;

  WITH ordered_members AS (
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
  ),
  rookie_draft_order AS (
    SELECT
      member_id,
      row_number() OVER (
        ORDER BY
          has_standings DESC,
          wins ASC,
          points_for ASC,
          member_id ASC
      )::int AS position
    FROM ordered_members
  )
  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM rookie_draft_order
   ORDER BY position;

  GET DIAGNOSTICS v_order_count = ROW_COUNT;
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
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
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
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
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
  END IF;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  PERFORM private.arm_next_snake_pick_timer(
    v_draft.id,
    now() + make_interval(secs => p_pick_timer_seconds)
  );

  IF NOT v_is_mock THEN
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
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[]);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_league_settings_atomic(
  p_league_id uuid,
  p_settings jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_user_id uuid := (SELECT auth.uid());
  v_touches_structural boolean;
  v_key text;
  v_skip int[];
  v_current public.league_seasons%ROWTYPE;
  v_scoring_settings jsonb;
  v_roster_size int;
  v_ir_slots int;
  v_taxi_slots int;
  v_auction_budget int;
  v_playoff_start_week int;
  v_playoff_total_weeks int;
  v_playoff_round_weeks int[];
  v_trade_deadline date;
  v_trade_deadline_set boolean := false;
  v_trade_deadline_text text;
  v_season_year int;
  v_weekly_add_limit int;
  v_weekly_add_unlimited boolean;
  v_waiver_mode text;
  v_faab_starting_budget int;
  v_trade_veto_mode text;
  v_trade_veto_window_hours int;
  v_trade_veto_threshold_percent int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can change settings.'
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_key IN ARRAY ARRAY['team_limit','playoff_entrants','taxi_max_seasons'] LOOP
    IF p_settings ? v_key AND (jsonb_typeof(p_settings->v_key)<>'number' OR (p_settings->>v_key)!~'^[0-9]+$') THEN
      RAISE EXCEPTION '% must be a positive whole number.',v_key USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF p_settings ? 'team_limit' AND ((p_settings->>'team_limit')::int NOT BETWEEN 2 AND 30 OR
      (p_settings->>'team_limit')::int < (SELECT count(*) FROM public.league_members WHERE league_id=p_league_id)) THEN
    RAISE EXCEPTION 'Team limit must be between 2 and 30 and include every current team.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_entrants' AND (p_settings->>'playoff_entrants')::int NOT BETWEEN 2 AND 8 THEN
    RAISE EXCEPTION 'Choose 2 through 8 playoff entrants.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'taxi_rule' AND (p_settings->>'taxi_rule') NOT IN ('drafted_rookies','rookies_or_64_games') THEN
    RAISE EXCEPTION 'Choose a valid taxi eligibility rule.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'taxi_max_seasons' AND (p_settings->>'taxi_max_seasons')::int NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Taxi tenure must be 1 or 2 seasons.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'allow_inactive_trades' AND jsonb_typeof(p_settings->'allow_inactive_trades')<>'boolean' THEN
    RAISE EXCEPTION 'Allow IR and taxi trades must be true or false.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'playoff_round_lengths' AND (jsonb_typeof(p_settings->'playoff_round_lengths')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings->'playoff_round_lengths') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$')) THEN
    RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE='22023';
  END IF;
  IF p_settings ? 'scoring_settings' AND jsonb_typeof(p_settings -> 'scoring_settings') = 'object' THEN
    v_scoring_settings := p_settings -> 'scoring_settings';
  END IF;

  IF p_settings ? 'roster_size' AND jsonb_typeof(p_settings -> 'roster_size') = 'number' THEN
    v_roster_size := (p_settings ->> 'roster_size')::int;
    IF v_roster_size <= 0 THEN
      RAISE EXCEPTION 'roster_size must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'ir_slots' AND jsonb_typeof(p_settings -> 'ir_slots') = 'number' THEN
    v_ir_slots := (p_settings ->> 'ir_slots')::int;
    IF v_ir_slots < 0 THEN
      RAISE EXCEPTION 'ir_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'taxi_slots' AND jsonb_typeof(p_settings -> 'taxi_slots') = 'number' THEN
    v_taxi_slots := (p_settings ->> 'taxi_slots')::int;
    IF v_taxi_slots < 0 THEN
      RAISE EXCEPTION 'taxi_slots must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'auction_budget' AND jsonb_typeof(p_settings -> 'auction_budget') = 'number' THEN
    v_auction_budget := (p_settings ->> 'auction_budget')::int;
    IF v_auction_budget <= 0 THEN
      RAISE EXCEPTION 'auction_budget must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_start_week' THEN
    IF jsonb_typeof(p_settings -> 'playoff_start_week') <> 'number'
       OR (p_settings ->> 'playoff_start_week') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Playoff start week must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_start_week := (p_settings ->> 'playoff_start_week')::int;
    IF v_playoff_start_week <= 0 THEN
      RAISE EXCEPTION 'playoff_start_week must be a positive integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'playoff_total_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_total_weeks') <> 'number'
       OR (p_settings ->> 'playoff_total_weeks') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
    v_playoff_total_weeks := (p_settings ->> 'playoff_total_weeks')::int;
    IF v_playoff_total_weeks < 1 THEN
      RAISE EXCEPTION 'Total playoff weeks must be a positive whole number.' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'playoff_round_weeks' THEN
    IF jsonb_typeof(p_settings -> 'playoff_round_weeks') <> 'array' THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') AS value
      WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value::text::int ORDER BY ordinality) INTO v_playoff_round_weeks
      FROM jsonb_array_elements(p_settings -> 'playoff_round_weeks') WITH ORDINALITY AS entry(value, ordinality);
    IF v_playoff_round_weeks IS NULL THEN
      RAISE EXCEPTION 'Enter positive whole weeks for each playoff round.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The deadline is a month and day ("MM-DD") that repeats every season; a
  -- full date keeps only its month and day. It is stored as the date inside
  -- the league's current season. JSON null removes it.
  IF p_settings ? 'trade_deadline' THEN
    v_trade_deadline_set := true;
    IF jsonb_typeof(p_settings -> 'trade_deadline') = 'string' THEN
      v_trade_deadline_text := trim(p_settings ->> 'trade_deadline');
      BEGIN
        IF v_trade_deadline_text ~ '^[0-9]{1,2}-[0-9]{1,2}$' THEN
          v_trade_deadline := make_date(
            2000,
            split_part(v_trade_deadline_text, '-', 1)::int,
            split_part(v_trade_deadline_text, '-', 2)::int
          );
        ELSE
          v_trade_deadline := v_trade_deadline_text::date;
        END IF;
      EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11.'
          USING ERRCODE = '22023';
      END;

      SELECT season.season_year
        INTO v_season_year
        FROM public.league_seasons AS season
       WHERE season.league_id = p_league_id
         AND season.is_current;
      v_trade_deadline := private.trade_deadline_for_season(
        v_trade_deadline,
        COALESCE(v_season_year, private.setup_season_year_et())
      );
    ELSIF jsonb_typeof(p_settings -> 'trade_deadline') <> 'null' THEN
      RAISE EXCEPTION 'trade_deadline must be a month and day such as 02-11, or null.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'weekly_add_unlimited' THEN
    IF jsonb_typeof(p_settings -> 'weekly_add_unlimited') <> 'boolean' THEN
      RAISE EXCEPTION 'weekly_add_unlimited must be a boolean.'
        USING ERRCODE = '22023';
    END IF;
    v_weekly_add_unlimited := (p_settings ->> 'weekly_add_unlimited')::boolean;
  END IF;

  IF p_settings ? 'weekly_add_limit' AND jsonb_typeof(p_settings -> 'weekly_add_limit') = 'number' THEN
    v_weekly_add_limit := (p_settings ->> 'weekly_add_limit')::int;
    IF v_weekly_add_limit < 1 THEN
      RAISE EXCEPTION 'weekly_add_limit must be at least 1, or use unlimited mode.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'waiver_mode' AND jsonb_typeof(p_settings -> 'waiver_mode') = 'string' THEN
    v_waiver_mode := p_settings ->> 'waiver_mode';
    IF v_waiver_mode NOT IN ('rolling', 'faab') THEN
      RAISE EXCEPTION 'waiver_mode must be rolling or faab.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'faab_starting_budget' AND jsonb_typeof(p_settings -> 'faab_starting_budget') = 'number' THEN
    v_faab_starting_budget := (p_settings ->> 'faab_starting_budget')::int;
    IF v_faab_starting_budget < 0 THEN
      RAISE EXCEPTION 'faab_starting_budget must be a non-negative integer.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_mode' AND jsonb_typeof(p_settings -> 'trade_veto_mode') = 'string' THEN
    v_trade_veto_mode := p_settings ->> 'trade_veto_mode';
    IF v_trade_veto_mode NOT IN ('disabled', 'commissioner', 'member_vote') THEN
      RAISE EXCEPTION 'trade_veto_mode must be disabled, commissioner, or member_vote.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_window_hours' AND jsonb_typeof(p_settings -> 'trade_veto_window_hours') = 'number' THEN
    v_trade_veto_window_hours := (p_settings ->> 'trade_veto_window_hours')::int;
    IF v_trade_veto_window_hours < 0 OR v_trade_veto_window_hours > 168 THEN
      RAISE EXCEPTION 'trade_veto_window_hours must be between 0 and 168.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_settings ? 'trade_veto_threshold_percent' AND jsonb_typeof(p_settings -> 'trade_veto_threshold_percent') = 'number' THEN
    v_trade_veto_threshold_percent := (p_settings ->> 'trade_veto_threshold_percent')::int;
    IF v_trade_veto_threshold_percent < 1 OR v_trade_veto_threshold_percent > 100 THEN
      RAISE EXCEPTION 'trade_veto_threshold_percent must be between 1 and 100.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_touches_structural :=
       v_scoring_settings IS NOT NULL
    OR v_roster_size IS NOT NULL
    OR v_ir_slots IS NOT NULL
    OR v_taxi_slots IS NOT NULL
    OR v_auction_budget IS NOT NULL
    OR p_settings ? 'team_limit';

  IF v_touches_structural
     AND v_league.status IS DISTINCT FROM 'setup'::public.league_status
  THEN
    RAISE EXCEPTION
      'Structural league settings (scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget) can only be changed before the draft starts.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.leagues
     SET team_limit = CASE WHEN p_settings ? 'team_limit' THEN (p_settings->>'team_limit')::int ELSE team_limit END,
         taxi_rule = COALESCE(p_settings->>'taxi_rule',taxi_rule),
         taxi_max_seasons = CASE WHEN p_settings ? 'taxi_max_seasons' THEN (p_settings->>'taxi_max_seasons')::int ELSE taxi_max_seasons END,
         allow_inactive_trades = CASE WHEN p_settings ? 'allow_inactive_trades' THEN (p_settings->>'allow_inactive_trades')::boolean ELSE allow_inactive_trades END,
         playoff_entrants = CASE WHEN p_settings ? 'playoff_entrants' THEN (p_settings->>'playoff_entrants')::int ELSE playoff_entrants END,
         playoff_round_lengths = CASE WHEN p_settings ? 'playoff_round_lengths' THEN ARRAY(SELECT jsonb_array_elements_text(p_settings->'playoff_round_lengths'))::int[] ELSE playoff_round_lengths END,
         scoring_settings = COALESCE(v_scoring_settings, scoring_settings),
         roster_size = COALESCE(v_roster_size, roster_size),
         ir_slots = COALESCE(v_ir_slots, ir_slots),
         taxi_slots = COALESCE(v_taxi_slots, taxi_slots),
         auction_budget = COALESCE(v_auction_budget, auction_budget),
         playoff_start_week = COALESCE(v_playoff_start_week, playoff_start_week),
         playoff_total_weeks = COALESCE(v_playoff_total_weeks, playoff_total_weeks),
         playoff_round_weeks = COALESCE(v_playoff_round_weeks, playoff_round_weeks),
         trade_deadline = CASE WHEN v_trade_deadline_set THEN v_trade_deadline ELSE trade_deadline END,
         weekly_add_limit = CASE
           WHEN v_weekly_add_unlimited IS TRUE THEN NULL
           WHEN v_weekly_add_limit IS NOT NULL THEN v_weekly_add_limit
           ELSE weekly_add_limit
         END,
         waiver_mode = COALESCE(v_waiver_mode, waiver_mode),
         faab_starting_budget = COALESCE(v_faab_starting_budget, faab_starting_budget),
         trade_veto_mode = COALESCE(v_trade_veto_mode, trade_veto_mode),
         trade_veto_window_hours = COALESCE(v_trade_veto_window_hours, trade_veto_window_hours),
         trade_veto_threshold_percent = COALESCE(v_trade_veto_threshold_percent, trade_veto_threshold_percent)
   WHERE id = p_league_id;

  IF p_settings ? 'skipped_weeks' THEN
    IF jsonb_typeof(p_settings->'skipped_weeks')<>'array' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_settings->'skipped_weeks') value
        WHERE jsonb_typeof(value)<>'number' OR value::text!~'^[0-9]+$') THEN
      RAISE EXCEPTION 'Skipped weeks must be positive whole week numbers.' USING ERRCODE='22023';
    END IF;
    SELECT ARRAY(SELECT DISTINCT value::int FROM jsonb_array_elements_text(p_settings->'skipped_weeks') value ORDER BY value::int) INTO v_skip;
    SELECT * INTO v_current FROM public.league_seasons WHERE league_id=p_league_id AND is_current FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'),hashtext(v_current.id::text));
    PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'),hashtext(v_current.id::text));
    IF NOT v_current.skipped_weeks <@ v_skip THEN
      RAISE EXCEPTION 'Skipped weeks cannot be restored. Contact the commissioner before skipping a week.';
    END IF;
    IF v_skip IS DISTINCT FROM v_current.skipped_weeks THEN
      IF EXISTS (SELECT 1 FROM unnest(v_skip) week WHERE week<1 OR week>=COALESCE(v_playoff_start_week,v_league.playoff_start_week)
        OR NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=v_current.season_year AND week_number=week)) THEN
        RAISE EXCEPTION 'Only calendar weeks before playoffs can be skipped.' USING ERRCODE='22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id=v_current.id AND matchup_type<>'regular_season') THEN
        RAISE EXCEPTION 'Weeks cannot be voided after playoff seeds are frozen.';
      END IF;
      UPDATE public.league_seasons SET skipped_weeks=v_skip WHERE id=v_current.id;
      UPDATE public.matchups SET is_voided=true WHERE league_season_id=v_current.id AND week_number=ANY(v_skip);
      PERFORM private.rebuild_regular_standings(p_league_id,v_current.id);
    END IF;
  END IF;

  IF v_faab_starting_budget IS NOT NULL THEN
    UPDATE public.faab_balances AS balance
       SET balance = v_faab_starting_budget,
           updated_at = now()
      FROM public.league_seasons AS season
     WHERE balance.league_id = p_league_id
       AND balance.league_season_id = season.id
       AND season.is_current = true
       AND balance.balance = v_league.faab_starting_budget;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_score_points_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_week_number int,
  p_matchups jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested int;
  v_distinct int;
  v_locked int;
  v_updated int;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(DISTINCT id) INTO v_requested, v_distinct
    FROM jsonb_to_recordset(p_matchups) AS requested(id uuid);
  IF v_requested = 0 THEN RETURN 0; END IF;
  IF v_requested <> v_distinct THEN
    RAISE EXCEPTION 'p_matchups contains duplicate or missing matchup ids.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  PERFORM 1 FROM public.league_seasons WHERE id = p_league_season_id AND league_id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN 0; END IF;
  IF EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id = p_league_season_id) THEN
    RAISE EXCEPTION 'Historical score inputs have been retired. Existing results are preserved.' USING ERRCODE = '55000';
  END IF;
  PERFORM private.assert_score_game_identity(p_league_season_id,p_week_number);
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(p_league_season_id::text));

  WITH locked AS (
    SELECT matchup.id FROM public.matchups AS matchup
    JOIN jsonb_to_recordset(p_matchups) AS requested(id uuid) ON requested.id = matchup.id
    WHERE matchup.league_id = p_league_id AND matchup.league_season_id = p_league_season_id
      AND matchup.week_number = p_week_number
    ORDER BY matchup.id FOR UPDATE OF matchup
  ) SELECT count(*) INTO v_locked FROM locked;
  IF v_locked <> v_requested THEN
    RAISE EXCEPTION 'p_matchups contains rows outside the target league season week.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.matchups AS matchup SET home_points = requested.home_points, away_points = requested.away_points
    FROM jsonb_to_recordset(p_matchups) AS requested(id uuid, home_points numeric, away_points numeric)
    WHERE matchup.id = requested.id
      AND NOT private.playoff_round_is_consumed(p_league_season_id, matchup.matchup_type)
      AND (matchup.matchup_type = 'regular_season' OR matchup.is_finalized IS NOT TRUE)
      AND (matchup.home_points IS DISTINCT FROM requested.home_points OR matchup.away_points IS DISTINCT FROM requested.away_points);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

CREATE TRIGGER validate_flexible_playoffs AFTER UPDATE OF playoff_entrants,playoff_round_lengths ON public.leagues
FOR EACH ROW WHEN ((OLD.playoff_entrants IS DISTINCT FROM NEW.playoff_entrants OR OLD.playoff_round_lengths IS DISTINCT FROM NEW.playoff_round_lengths)
  AND OLD.playoff_start_week IS NOT DISTINCT FROM NEW.playoff_start_week
  AND OLD.playoff_total_weeks IS NOT DISTINCT FROM NEW.playoff_total_weeks
  AND OLD.playoff_round_weeks IS NOT DISTINCT FROM NEW.playoff_round_weeks)
EXECUTE FUNCTION public.prevent_playoff_start_week_change_after_bracket();
CREATE TRIGGER enforce_skipped_matchup BEFORE INSERT OR UPDATE ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.enforce_skipped_matchup();
CREATE TRIGGER guard_trade_item_plan_reservations BEFORE INSERT OR UPDATE ON public.trade_items FOR EACH ROW EXECUTE FUNCTION private.guard_trade_plan_reservations();
CREATE TRIGGER guard_trade_participant_plan_reservations BEFORE INSERT OR UPDATE OF drop_player_ids ON public.trade_participants FOR EACH ROW EXECUTE FUNCTION private.guard_trade_plan_reservations();
CREATE TRIGGER guard_waiver_plan_reservations BEFORE INSERT OR UPDATE OF player_id,drop_player_id,status ON public.waiver_claims FOR EACH ROW EXECUTE FUNCTION private.guard_waiver_plan_reservations();
REVOKE ALL ON FUNCTION private.enforce_skipped_matchup() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.guard_trade_plan_reservations() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.guard_waiver_plan_reservations() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.league_playoff_round_plan(uuid,int) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.league_week_at_pacific(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.rebuild_regular_standings(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.taxi_player_eligible(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.taxi_start_year(uuid,uuid,int) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.validate_trade_rosters(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.accept_trade_with_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.accept_trade_with_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.set_trade_roster_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_trade_roster_plan_atomic(uuid,uuid,uuid,uuid[],uuid[],uuid[]) TO service_role;
RESET statement_timeout;
RESET lock_timeout;
