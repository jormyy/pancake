BEGIN;

CREATE TABLE public.lineup_player_pins (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL,
  member_id uuid NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  game_date date NOT NULL,
  pin text NOT NULL CHECK (pin IN ('start', 'bench')),
  PRIMARY KEY (league_id, league_season_id, member_id, player_id, game_date),
  FOREIGN KEY (member_id, league_id) REFERENCES public.league_members(id, league_id) ON DELETE CASCADE,
  FOREIGN KEY (league_season_id, league_id) REFERENCES public.league_seasons(id, league_id) ON DELETE CASCADE
);
CREATE INDEX lineup_player_pins_date_idx ON public.lineup_player_pins(game_date, league_id, league_season_id, member_id);
ALTER TABLE public.lineup_player_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lineup_player_pins FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lineup_player_pins TO authenticated;
GRANT ALL ON public.lineup_player_pins TO service_role;
CREATE POLICY lineup_player_pins_owner_read ON public.lineup_player_pins FOR SELECT TO authenticated
  USING (member_id IN (SELECT private.my_member_ids()));

CREATE OR REPLACE FUNCTION public.set_lineup_player_pin(p_league_id uuid, p_player_id uuid, p_date date, p_pin text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_season_id uuid;
  v_today date;
  v_roster public.roster_players%ROWTYPE;
BEGIN
  SELECT m.id, s.id, (now() AT TIME ZONE COALESCE(l.timezone, 'America/Los_Angeles'))::date
    INTO v_member_id, v_season_id, v_today
    FROM public.league_members m
    JOIN public.leagues l ON l.id = m.league_id AND l.deleted_at IS NULL
    JOIN public.league_seasons s ON s.league_id = l.id AND s.is_current
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.' USING ERRCODE = '42501';
  END IF;
  IF p_date IS NULL OR (p_pin IS NOT NULL AND p_pin NOT IN ('start', 'bench')) THEN
    RAISE EXCEPTION 'Choose Start, Auto, or Bench for a lineup date.' USING ERRCODE = '22023';
  END IF;
  IF p_date < v_today THEN
    RAISE EXCEPTION 'Past lineups cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(v_member_id::text), hashtext(p_date::text));
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, v_season_id);
  SELECT * INTO v_roster FROM public.roster_players
    WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on your roster.' USING ERRCODE = 'P0002';
  END IF;
  IF v_roster.is_on_ir OR v_roster.is_on_taxi THEN
    RAISE EXCEPTION 'Activate this player before setting a lineup pin.' USING ERRCODE = 'P0001';
  END IF;
  IF private.lineup_game_started(p_player_id, p_date) THEN
    RAISE EXCEPTION 'Lineup changes are locked after this player''s game has started.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pin IS NULL THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = p_league_id AND league_season_id = v_season_id
      AND member_id = v_member_id AND player_id = p_player_id AND game_date = p_date;
  ELSE
    INSERT INTO public.lineup_player_pins(league_id, league_season_id, member_id, player_id, game_date, pin)
      VALUES (p_league_id, v_season_id, v_member_id, p_player_id, p_date, p_pin)
      ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
      DO UPDATE SET pin = EXCLUDED.pin WHERE lineup_player_pins.pin IS DISTINCT FROM EXCLUDED.pin;
  END IF;
  RETURN jsonb_build_object('playerId', p_player_id, 'date', p_date, 'lineupPin', p_pin);
END;
$$;

CREATE OR REPLACE FUNCTION private.clear_roster_lineup_pins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = OLD.league_id AND league_season_id = OLD.league_season_id
      AND member_id = OLD.member_id AND player_id = OLD.player_id;
    RETURN OLD;
  END IF;
  IF (OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id)
    IS DISTINCT FROM (NEW.league_id, NEW.league_season_id, NEW.member_id, NEW.player_id) THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = OLD.league_id AND league_season_id = OLD.league_season_id
      AND member_id = OLD.member_id AND player_id = OLD.player_id;
  END IF;
  IF (NEW.is_on_ir AND NOT OLD.is_on_ir) OR (NEW.is_on_taxi AND NOT OLD.is_on_taxi) THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = NEW.league_id AND league_season_id = NEW.league_season_id
      AND member_id = NEW.member_id AND player_id = NEW.player_id
      AND game_date >= (SELECT (now() AT TIME ZONE COALESCE(timezone, 'America/Los_Angeles'))::date
        FROM public.leagues WHERE id = NEW.league_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_lineup_player_pins(
  p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_game_date date, p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lineup_player_pins
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id
      AND member_id = p_member_id AND game_date = p_game_date) THEN RETURN; END IF;
  IF EXISTS (
    WITH assignments AS MATERIALIZED (
      SELECT (a->>'player_id')::uuid AS player_id, (a->>'slot_type')::public.roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) a WHERE a->>'slot_type' NOT IN ('BE', 'IR')
    ), roster AS MATERIALIZED (
      SELECT p.id, p.nba_team, p.injury_status, pin.pin,
        COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text]) AS positions
      FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
      LEFT JOIN public.lineup_player_pins pin ON pin.league_id = rp.league_id
        AND pin.league_season_id = rp.league_season_id AND pin.member_id = rp.member_id
        AND pin.player_id = rp.player_id AND pin.game_date = p_game_date
      WHERE rp.league_id = p_league_id AND rp.league_season_id = p_league_season_id
        AND rp.member_id = p_member_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
        AND NOT private.lineup_game_started(p.id, p_game_date)
    )
    SELECT 1 FROM assignments a JOIN roster starter ON starter.id = a.player_id
      JOIN roster reserve ON reserve.id <> starter.id
        AND reserve.positions && public.lineup_slot_allowed_positions(a.slot_type)
    WHERE NOT EXISTS (SELECT 1 FROM assignments used WHERE used.player_id = reserve.id)
      AND ((starter.pin = 'bench' AND reserve.pin IS DISTINCT FROM 'bench')
        OR (starter.pin IS DISTINCT FROM 'start' AND reserve.pin = 'start'
          AND COALESCE(lower(reserve.injury_status), '') <> 'out'
          AND COALESCE(lower(reserve.injury_status), '') NOT LIKE 'ir%'
          AND EXISTS (SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date
            AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = reserve.nba_team OR g.away_team = reserve.nba_team))))
  ) THEN
    RAISE EXCEPTION 'Lineup pins changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pre_tipoff_lineup_context(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'date', (now() AT TIME ZONE 'America/New_York')::date,
    'seasonYear', ls.season_year,
    'weekNumber', sw.week_number,
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'playerId', p.id, 'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0
          THEN p.eligible_positions ELSE ARRAY[p.position::text] END,
        'injuryStatus', p.injury_status,
        'lineupPin', (SELECT pin FROM public.lineup_player_pins WHERE league_id = p_league_id
          AND league_season_id = p_league_season_id AND member_id = p_member_id
          AND player_id = p.id AND game_date = sw_date.game_date),
        'gameTime', (SELECT min(COALESCE(g.game_time, g.started_at)) FROM public.nba_games g
          WHERE g.game_date = sw_date.game_date AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)),
        'locked', private.lineup_game_started(p.id, sw_date.game_date),
        'hasGame', EXISTS (SELECT 1 FROM public.nba_games g
          WHERE g.game_date = sw_date.game_date AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = p.nba_team OR g.away_team = p.nba_team))
      ) ORDER BY p.id)
      FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
      WHERE rp.league_id = p_league_id AND rp.league_season_id = p_league_season_id
        AND rp.member_id = p_member_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
    ), '[]'::jsonb),
    'templates', COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'count', slot_count) ORDER BY slot_type)
      FROM public.lineup_slot_templates WHERE league_id = p_league_id
        AND slot_type NOT IN ('BE', 'IR')), '[]'::jsonb),
    'stored', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'player_id', wl.player_id, 'slot_type', wl.slot_type,
      'is_auto_set', wl.is_auto_set, 'week_number', wl.week_number,
      'locked', private.lineup_game_started(wl.player_id, wl.game_date)
    ) ORDER BY wl.player_id) FROM public.weekly_lineups wl
      WHERE wl.league_id = p_league_id AND wl.league_season_id = p_league_season_id
        AND wl.member_id = p_member_id AND wl.game_date = sw_date.game_date), '[]'::jsonb)
  )
  FROM public.lineup_optimizer_settings s
  JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
  JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'America/New_York')::date AS game_date) sw_date
  LEFT JOIN public.season_weeks sw ON sw.season_year = ls.season_year
    AND sw_date.game_date BETWEEN sw.week_start AND sw.week_end
  WHERE s.league_id = p_league_id AND s.league_season_id = p_league_season_id
    AND s.member_id = p_member_id AND s.enabled;
$$;

CREATE OR REPLACE FUNCTION private.pre_tipoff_input_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
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

CREATE OR REPLACE FUNCTION public.view_lineup(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; target uuid := COALESCE((p_params->>'targetMemberId')::uuid, p_member_id);
  selected date; today date; starters jsonb; bench jsonb; ir jsonb; taxi jsonb; days jsonb; game_day jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  context := context || jsonb_build_object('weekNumber', COALESCE((context->>'weekNumber')::integer, 1));
  IF NOT EXISTS (SELECT 1 FROM public.league_members WHERE id = target AND league_id = p_league_id) THEN
    RAISE EXCEPTION 'This lineup is not available.' USING ERRCODE = '42501'; END IF;
  today := (context->>'today')::date;
  selected := COALESCE((p_params->>'date')::date, today);
  WITH assignments AS MATERIALIZED (
    SELECT player_id, slot_type FROM public.weekly_lineups WHERE member_id = target AND league_id = p_league_id
      AND league_season_id = (context->>'seasonId')::uuid AND game_date = selected
  ), roster AS MATERIALIZED (
    SELECT * FROM public.roster_players WHERE member_id = target AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
  ), players AS MATERIALIZED (
    SELECT p.id, r.is_on_ir, r.is_on_taxi, r.id AS roster_id, jsonb_build_object('rosterPlayerId', COALESCE(r.id::text, ''),
      'assetLocks', '[]'::jsonb, 'playerId', p.id, 'displayName', COALESCE(p.display_name, ''), 'position', p.position,
      'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0 THEN to_jsonb(p.eligible_positions)
        WHEN p.position IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.position) END,
      'nbaTeam', p.nba_team, 'yearsExp', p.years_exp, 'careerGames', p.career_regular_season_games,
      'lineupPin', (SELECT pin FROM public.lineup_player_pins WHERE league_id = p_league_id
        AND league_season_id = (context->>'seasonId')::uuid AND member_id = target
        AND player_id = p.id AND game_date = selected),
      'injuryStatus', p.injury_status, 'nbaId', p.nba_id, 'espnId', p.espn_id) AS data
    FROM public.players p LEFT JOIN roster r ON r.player_id = p.id
    WHERE r.id IS NOT NULL OR EXISTS (SELECT 1 FROM assignments a WHERE a.player_id = p.id)
  ), placed AS MATERIALIZED (
    SELECT a.*, row_number() OVER (PARTITION BY a.slot_type ORDER BY a.player_id) AS slot_number
    FROM assignments a LEFT JOIN roster r ON r.player_id = a.player_id
    WHERE a.slot_type NOT IN ('BE', 'IR') AND (selected <= today OR NOT COALESCE(r.is_on_ir OR r.is_on_taxi, false))
  ), occupied AS MATERIALIZED (
    SELECT t.slot_type, sequence.number, player.data, player.id FROM public.lineup_slot_templates t
      CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
      LEFT JOIN placed a ON a.slot_type = t.slot_type AND a.slot_number = sequence.number
      LEFT JOIN players player ON player.id = a.player_id
    WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
  )
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'player', data) ORDER BY slot_type, number) FROM occupied), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.roster_id IS NOT NULL AND NOT p.is_on_ir AND NOT p.is_on_taxi
      AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)
      AND NOT (selected < today AND EXISTS (SELECT 1 FROM public.roster_transactions transaction
        WHERE transaction.member_id = target AND transaction.league_id = p_league_id AND transaction.league_season_id = (context->>'seasonId')::uuid
          AND transaction.player_id = p.id AND transaction.transaction_type IN ('fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over')
          AND transaction.occurred_at > ((selected + 1)::timestamp AT TIME ZONE 'America/New_York') - interval '1 millisecond'))), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_ir AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]'),
    COALESCE(jsonb_agg(p.data ORDER BY p.id) FILTER (WHERE p.is_on_taxi AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id = p.id)), '[]')
  INTO starters, bench, ir, taxi FROM players p;
  WITH dates AS (
    SELECT generate_series(CASE WHEN week.week_number = 1 THEN date_trunc('week', week.week_start::timestamp)::date ELSE week.week_start END,
      week.week_end, interval '1 day')::date AS day FROM public.season_weeks week
      WHERE week.season_year = (context->>'seasonYear')::integer AND week.week_number = (context->>'weekNumber')::integer
    UNION
    SELECT DISTINCT game.game_date FROM public.nba_games game
      WHERE game.season_year = (context->>'seasonYear')::integer AND game.week_number = (context->>'weekNumber')::integer
        AND NOT EXISTS (SELECT 1 FROM public.season_weeks week WHERE week.season_year = (context->>'seasonYear')::integer
          AND week.week_number = (context->>'weekNumber')::integer)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', day, 'dayLabel', substring('SMTWTFS', extract(dow FROM day)::integer + 1, 1),
    'dateNum', extract(day FROM day), 'isToday', day = (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date,
    'hasGames', EXISTS (SELECT 1 FROM public.nba_games g WHERE g.season_year = (context->>'seasonYear')::integer AND g.game_date = day),
    'playingTeams', COALESCE((SELECT jsonb_agg(team ORDER BY game_id, side) FROM (
      SELECT g.id AS game_id, 0 AS side, g.home_team AS team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
      UNION ALL SELECT g.id, 1, g.away_team FROM public.nba_games g WHERE g.game_date = day AND g.season_year = (context->>'seasonYear')::integer
    ) teams), '[]')) ORDER BY day), '[]') INTO days FROM dates;
  game_day := public.view_game_day(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'playerIds',
    COALESCE((SELECT jsonb_agg(DISTINCT id) FROM (
      SELECT item->'player'->>'playerId' AS id FROM jsonb_array_elements(starters) item
      UNION SELECT item->>'playerId' FROM jsonb_array_elements(bench || ir || taxi) item) ids WHERE id IS NOT NULL), '[]')));
  RETURN jsonb_build_object('lockedAssets', '[]'::jsonb, 'context', context, 'date', selected, 'starters', starters, 'bench', bench, 'ir', ir, 'taxi', taxi,
    'benchSlots', COALESCE((SELECT slot_count FROM public.lineup_slot_templates WHERE league_id = p_league_id AND slot_type = 'BE'), 0),
    'weekDays', days, 'games', game_day->'games', 'startedTeams', game_day->'startedTeams', 'teamMatchups', game_day->'teamMatchups', 'liveStats', game_day->'liveStats',
    'optimizer', (SELECT to_jsonb(settings) FROM public.lineup_optimizer_settings settings
      WHERE settings.member_id = p_member_id AND settings.league_season_id = (context->>'seasonId')::uuid));
END;
$$;

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
      'lineupPin', (SELECT pin FROM public.lineup_player_pins WHERE league_id = p_league_id
        AND league_season_id = (context->>'seasonId')::uuid AND member_id = target
        AND player_id = p.id AND game_date = (context->>'today')::date),
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
    LEFT JOIN LATERAL (
      SELECT fantasy.avg_fantasy_points FROM public.v_player_avg_fantasy_points fantasy
      WHERE average.player_id IS NULL AND fantasy.league_id=p_league_id
        AND fantasy.player_id=p.id AND fantasy.season_year=COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())
      OFFSET 0
    ) source_fantasy ON true
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

CREATE OR REPLACE FUNCTION public.view_home(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; matchup public.matchups%ROWTYPE; opponent uuid; subject uuid; selected date;
  requested_week integer := (p_params->>'weekNumber')::integer;
  mine jsonb; theirs jsonb; records jsonb; matchup_data jsonb; league_matchups jsonb; announcements jsonb; league_today date; league_week integer; basis jsonb;
  payload jsonb; lineup_key text; compact_groups jsonb; live_games jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  context := context || jsonb_build_object('version',COALESCE((SELECT version FROM public.league_versions WHERE league_id=p_league_id),0)::text);
  league_today := (now() AT TIME ZONE COALESCE(context->'league'->>'timezone', 'America/Los_Angeles'))::date;
  SELECT week_number INTO league_week FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer
    ORDER BY CASE WHEN league_today BETWEEN week_start AND week_end THEN 0 WHEN week_start > league_today THEN 1 ELSE 2 END,
      CASE WHEN week_start >= league_today THEN week_start END, week_end DESC LIMIT 1;
  context := context || jsonb_build_object('today', league_today, 'weekNumber', COALESCE((p_params->>'weekNumber')::integer, league_week));
  p_params := p_params || jsonb_build_object('weekNumber', context->'weekNumber');
  IF p_params->>'matchupId' IS NOT NULL THEN
    SELECT * INTO matchup FROM public.matchups WHERE id=(p_params->>'matchupId')::uuid
      AND league_id=p_league_id AND league_season_id=(context->>'seasonId')::uuid AND NOT is_voided;
    IF NOT FOUND THEN RAISE EXCEPTION 'This matchup is not available.' USING ERRCODE='42501'; END IF;
    SELECT week_number INTO league_week FROM public.season_weeks
      WHERE season_year=(context->>'seasonYear')::integer
        AND COALESCE((p_params->>'date')::date,league_today) BETWEEN week_start AND week_end
        AND week_number BETWEEN matchup.week_number AND COALESCE(matchup.end_week_number,matchup.week_number);
    context := context || jsonb_build_object('weekNumber',COALESCE(requested_week,league_week,matchup.week_number));
    p_params := p_params || jsonb_build_object('weekNumber',context->'weekNumber');
  ELSE
    SELECT * INTO matchup FROM public.matchups WHERE league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
    AND NOT is_voided AND p_member_id IN (home_member_id, away_member_id) AND week_number <= (context->>'weekNumber')::integer
    AND COALESCE(end_week_number, week_number) >= (context->>'weekNumber')::integer
    AND (context->'season'->>'is_current')::boolean ORDER BY week_number DESC, id LIMIT 1;
  END IF;
  IF p_params->>'section'='forecast' THEN
    RETURN jsonb_build_object('section','forecast','context',jsonb_build_object('leagueId',p_league_id,
      'seasonId',context->'seasonId','version',context->'version'),'matchup',jsonb_build_object('id',matchup.id),
      'forecast',private.compact_home_forecast(public.get_matchup_forecast(matchup.id)));
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(row)), '[]') INTO announcements FROM (SELECT * FROM public.notif_list_announcements(p_league_id) item
    WHERE item.author_member_id IS DISTINCT FROM p_member_id AND item.published_at >= now() - interval '14 days' LIMIT 5) row;
  IF matchup.id IS NULL THEN RETURN jsonb_build_object('context', context, 'matchup', NULL, 'weekDays', '[]'::jsonb,
    'leagueMatchups', '[]'::jsonb, 'myLineup', NULL, 'oppLineup', NULL, 'forecast', NULL, 'announcements', announcements,
    'todaysGames', '[]'::jsonb, 'liveStats', '{}'::jsonb, 'startedTeams', '[]'::jsonb, 'teamMatchups', '{}'::jsonb,
    'selectedDate', COALESCE(p_params->>'date', context->>'today')); END IF;
  subject := CASE WHEN p_member_id IN (matchup.home_member_id,matchup.away_member_id) THEN p_member_id ELSE matchup.home_member_id END;
  opponent := CASE WHEN matchup.home_member_id = subject THEN matchup.away_member_id ELSE matchup.home_member_id END;
  selected := COALESCE((p_params->>'date')::date, (context->>'today')::date);
  SELECT GREATEST(LEAST(selected, week_end), CASE WHEN week_number = 1 THEN date_trunc('week', week_start::timestamp)::date ELSE week_start END)
    INTO selected FROM public.season_weeks WHERE season_year = (context->>'seasonYear')::integer AND week_number = (context->>'weekNumber')::integer;
  mine := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected,'targetMemberId',subject));
  theirs := public.view_lineup(p_league_id, p_member_id, p_params || jsonb_build_object('date', selected, 'targetMemberId', opponent));
  records := public.view_standings(p_league_id, p_member_id, p_params)->'standings';
  SELECT jsonb_build_object('id', matchup.id, 'weekNumber', (context->>'weekNumber')::integer,
    'roundStartWeek', matchup.week_number, 'roundEndWeek', COALESCE(matchup.end_week_number, matchup.week_number),
    'myPoints', CASE WHEN matchup.home_member_id = subject THEN matchup.home_points ELSE matchup.away_points END,
    'opponentPoints', CASE WHEN matchup.home_member_id = subject THEN matchup.away_points ELSE matchup.home_points END,
    'myTeamName', COALESCE(member.team_name, 'My Team'), 'opponentTeamName', COALESCE(other.team_name, 'Opponent'),
    'myUsername', COALESCE(profile.display_name, ''), 'opponentUsername', COALESCE(other_profile.display_name, ''),
    'myWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = subject::text), '0'),
    'myLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = subject::text), '0'),
    'opponentWins', COALESCE((SELECT row->'wins' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'opponentLosses', COALESCE((SELECT row->'losses' FROM jsonb_array_elements(records) row WHERE row->>'memberId' = opponent::text), '0'),
    'isFinalized', matchup.is_finalized, 'iWon', CASE WHEN matchup.winner_member_id IS NOT NULL THEN matchup.winner_member_id = subject END,
    'myMemberId', subject, 'opponentMemberId', opponent, 'seasonId', matchup.league_season_id, 'seasonYear', (context->>'seasonYear')::integer)
  INTO matchup_data FROM public.league_members member JOIN public.league_members other ON other.id = opponent
    LEFT JOIN public.profiles profile ON profile.id = member.user_id LEFT JOIN public.profiles other_profile ON other_profile.id = other.user_id
    WHERE member.id = subject;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'homeMemberId', m.home_member_id, 'awayMemberId', m.away_member_id,
    'homeTeamName', COALESCE(home.team_name, 'Home'), 'awayTeamName', COALESCE(away.team_name, 'Away'),
    'homePoints', m.home_points, 'awayPoints', m.away_points, 'isFinalized', m.is_finalized,
    'isMine', p_member_id IN (m.home_member_id, m.away_member_id)) ORDER BY p_member_id IN (m.home_member_id, m.away_member_id) DESC,
      GREATEST(COALESCE(m.home_points, 0), COALESCE(m.away_points, 0)) DESC, m.id), '[]')
  INTO league_matchups FROM public.matchups m JOIN public.league_members home ON home.id = m.home_member_id
    JOIN public.league_members away ON away.id = m.away_member_id
  WHERE m.league_id = p_league_id AND m.league_season_id = matchup.league_season_id AND NOT m.is_voided
    AND m.week_number <= (context->>'weekNumber')::integer AND COALESCE(m.end_week_number, m.week_number) >= (context->>'weekNumber')::integer;
  basis := CASE WHEN selected=league_today OR EXISTS(SELECT 1 FROM public.nba_games game
    WHERE game.season_year=(context->>'seasonYear')::integer
      AND game.week_number BETWEEN matchup.week_number AND COALESCE(matchup.end_week_number,matchup.week_number)
      AND (game.status='InProgress' OR game.status='Final' AND game.stats_synced_at IS NULL)) THEN private.live_score_basis(p_league_id,matchup.league_season_id,
    (context->>'weekNumber')::integer,selected,matchup.id) ELSE '[]'::jsonb END;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('nba_game_id',game.nba_game_id,
    'game_date',game.game_date,'game_time',game.game_time,'status',game.status,'stats_synced_at',game.stats_synced_at)), '[]'::jsonb)
    INTO live_games FROM public.nba_games game WHERE game.season_year=(context->>'seasonYear')::integer
    AND private.lineup_game_available(game.status,game.game_status_text)
    AND (game.status<>'Final' OR game.stats_synced_at IS NULL)
    AND game.nba_game_id IN (SELECT player->>'gameId' FROM jsonb_array_elements(basis) item,
      jsonb_array_elements(item->'players') player);
  IF p_params->>'compact'='true' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'id',item->'homeMemberId',item->'awayMemberId',item->'homePoints',
      item->'awayPoints',item->'finalized',item->'ready',(SELECT COALESCE(jsonb_agg(jsonb_build_array(player->'playerId',
        CASE WHEN player->>'memberId'=item->>'homeMemberId' THEN 0 ELSE 1 END,player->'nbaId',player->'espnId',player->'team',
        player->'gameId',player->'savedPoints',player->'savedAt',player->'starter',player->'final',player->'gameDate')),'[]'::jsonb)
        FROM jsonb_array_elements(item->'players') player))),'[]'::jsonb)
    INTO basis FROM jsonb_array_elements(basis) item;
    context := (context-'member'-'season') || jsonb_build_object('league',jsonb_build_object('id',p_league_id,
      'timezone',context->'league'->'timezone','scoring_settings',context->'league'->'scoring_settings'));
  END IF;
  payload := jsonb_build_object('context', context, 'matchup', matchup_data, 'weekDays', mine->'weekDays', 'selectedDate', selected,
    'leagueMatchups', league_matchups, 'myLineup', mine - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'oppLineup', theirs - ARRAY['context','date','weekDays','games','optimizer','startedTeams','teamMatchups','liveStats'],
    'forecast', public.get_matchup_forecast(matchup.id), 'announcements', announcements, 'todaysGames', mine->'games',
    'liveStats', (mine->'liveStats') || (theirs->'liveStats'), 'startedTeams', mine->'startedTeams', 'teamMatchups', mine->'teamMatchups',
    'liveBasis',basis,'liveGames',live_games);
  IF selected IS DISTINCT FROM league_today THEN
    FOREACH lineup_key IN ARRAY ARRAY['myLineup','oppLineup'] LOOP
      WITH groups AS (SELECT key,value FROM jsonb_each(payload->lineup_key) WHERE key IN ('starters','bench','ir','taxi')),
      rows AS (SELECT key,item,ordinality,CASE WHEN key='starters' THEN item->'player' ELSE item END AS player
        FROM groups CROSS JOIN LATERAL jsonb_array_elements(value) WITH ORDINALITY AS entry(item,ordinality)),
      tagged AS (SELECT key,item,ordinality,CASE WHEN player IS NULL OR player='null'::jsonb THEN player
        ELSE player || jsonb_build_object('lineupPin', (SELECT pin FROM public.lineup_player_pins
          WHERE league_id=p_league_id AND league_season_id=(context->>'seasonId')::uuid
            AND member_id=CASE WHEN lineup_key='myLineup' THEN subject ELSE opponent END
            AND player_id=(player->>'playerId')::uuid AND game_date=league_today)) END AS player FROM rows),
      combined AS (SELECT key,jsonb_agg(CASE WHEN key='starters' THEN jsonb_set(item,'{player}',COALESCE(player,'null'::jsonb))
        ELSE player END ORDER BY ordinality) AS value FROM tagged GROUP BY key)
      SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO compact_groups FROM combined;
      payload:=jsonb_set(payload,ARRAY[lineup_key],(payload->lineup_key)||compact_groups);
    END LOOP;
  END IF;
  IF p_params->>'compact'='true' THEN
    FOREACH lineup_key IN ARRAY ARRAY['myLineup','oppLineup'] LOOP
      WITH groups AS (SELECT key,value FROM jsonb_each(payload->lineup_key) WHERE key IN ('starters','bench','ir','taxi')),
      rows AS (SELECT key,item,ordinality,CASE WHEN key='starters' THEN item->'player' ELSE item END AS player
        FROM groups CROSS JOIN LATERAL jsonb_array_elements(value) WITH ORDINALITY AS entry(item,ordinality)),
      packed AS (SELECT key,item,ordinality,CASE WHEN player IS NULL OR player='null'::jsonb THEN 'null'::jsonb
        ELSE jsonb_build_array(player->'rosterPlayerId',player->'playerId',player->'displayName',player->'position',
          player->'eligiblePositions',player->'nbaTeam',player->'yearsExp',player->'careerGames',player->'injuryStatus',
          player->'nbaId',player->'espnId',player->'assetLocks',player->'lineupPin') END AS player FROM rows),
      combined AS (SELECT key,jsonb_agg(CASE WHEN key='starters' THEN jsonb_build_array(item->'slotType',player)
        ELSE player END ORDER BY ordinality) AS value FROM packed GROUP BY key)
      SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO compact_groups FROM combined;
      payload:=jsonb_set(payload,ARRAY[lineup_key],((payload->lineup_key)-'lockedAssets')||compact_groups);
    END LOOP;
    SELECT COALESCE(jsonb_object_agg(key,jsonb_build_array(value->'points',value->'rebounds',value->'assists',value->'steals',
      value->'blocks',value->'turnovers',value->'threeMade',value->'fgMade',value->'fgAttempted',value->'ftMade',
      value->'ftAttempted',value->'fouls',value->'doubleDouble',value->'tripleDouble',value->'minutesPlayed',value->'didNotPlay')),'{}'::jsonb)
      INTO compact_groups FROM jsonb_each(payload->'liveStats');
    payload:=payload||jsonb_build_object('wireVersion',1,'liveStats',compact_groups);
    payload:=jsonb_set(payload,'{forecast}',private.compact_home_forecast(payload->'forecast'));
  END IF;
  IF p_params->>'section'='scores' THEN
    RETURN (payload-ARRAY['myLineup','oppLineup','forecast','announcements'])||jsonb_build_object('section','scores',
      'context',jsonb_build_object('leagueId',p_league_id,'seasonId',context->'seasonId','version',context->'version'),
      'forecastStale',payload->'forecast'->'stale');
  END IF;
  RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_week_number integer, p_moves jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_invalid_player_inactive boolean := false;
  v_locked_player text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_moves) AS m
     WHERE m->>'player_id' IS NULL
        OR m->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup move must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM moves
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup move.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (m->>'player_id')::uuid ORDER BY (m->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_moves) AS m
   WHERE m->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM roster_players
     WHERE member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND player_id = ANY (v_player_ids);

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM moves
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT f.slot_type
    INTO v_invalid_slot
    FROM final_lineups f
   WHERE NOT EXISTS (
     SELECT 1
       FROM lineup_slot_templates t
      WHERE t.league_id = p_league_id
        AND t.slot_type = f.slot_type
        AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT f.slot_type
    INTO v_invalid_slot
    FROM final_lineups f
   GROUP BY f.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = f.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is full.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  ),
  player_slots AS (
    SELECT
      p.display_name,
      f.slot_type,
      rp.is_on_ir,
      COALESCE(rp.is_on_taxi, false) AS is_on_taxi,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(f.slot_type) AS allowed_positions
      FROM final_lineups f
      JOIN roster_players rp
        ON rp.member_id = p_member_id
       AND rp.league_id = p_league_id
       AND rp.league_season_id = p_league_season_id
       AND rp.player_id = f.player_id
      JOIN players p ON p.id = f.player_id
  )
  SELECT display_name, slot_type, is_on_ir OR is_on_taxi
    INTO v_invalid_player, v_invalid_player_slot, v_invalid_player_inactive
    FROM player_slots
   WHERE is_on_ir OR is_on_taxi OR NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    IF v_invalid_player_inactive THEN
      RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
        USING ERRCODE = 'P0001';
    END IF;

    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM final_lineups f
        WHERE f.player_id = wl.player_id
          AND f.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  ),
  final_lineups AS (
    SELECT wl.player_id, wl.slot_type
      FROM weekly_lineups wl
     WHERE wl.member_id = p_member_id
       AND wl.league_id = p_league_id
       AND wl.league_season_id = p_league_season_id
       AND wl.game_date = p_game_date
       AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.player_id = wl.player_id)
    UNION ALL
    SELECT player_id, slot_type
      FROM moves
     WHERE slot_type <> 'BE'::roster_slot_type
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM final_lineups f
    JOIN players p ON p.id = f.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = f.player_id
     AND wl.slot_type = f.slot_type
   WHERE wl.id IS NULL
     AND private.lineup_game_started(f.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  DELETE FROM public.lineup_player_pins pin
   USING moves m
   WHERE pin.league_id = p_league_id AND pin.league_season_id = p_league_season_id
     AND pin.member_id = p_member_id AND pin.game_date = p_game_date AND pin.player_id = m.player_id
     AND ((pin.pin = 'start' AND m.slot_type = 'BE') OR (pin.pin = 'bench' AND m.slot_type <> 'BE'));

  WITH moves AS (
    SELECT (m->>'player_id')::uuid AS player_id, (m->>'slot_type')::roster_slot_type AS slot_type
    FROM jsonb_array_elements(p_moves) AS m
  )
  DELETE FROM weekly_lineups wl
   USING moves m
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = m.player_id
     AND (m.slot_type = 'BE'::roster_slot_type OR wl.slot_type <> m.slot_type);

  WITH moves AS (
    SELECT
      (m->>'player_id')::uuid AS player_id,
      (m->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_moves) AS m
  )
  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    m.player_id,
    p_week_number,
    p_game_date,
    m.slot_type,
    false,
    now()
    FROM moves m
   WHERE m.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = m.player_id
          AND wl.slot_type = m.slot_type
     )
  ON CONFLICT (league_id, league_season_id, member_id, player_id, game_date)
  DO UPDATE SET
    slot_type = EXCLUDED.slot_type,
    week_number = EXCLUDED.week_number,
    is_auto_set = EXCLUDED.is_auto_set,
    set_at = EXCLUDED.set_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic_unchecked(p_member_id uuid, p_league_id uuid, p_league_season_id uuid, p_game_date date, p_assignments jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_player_ids uuid[];
  v_owned_count int;
  v_total_count int;
  v_duplicate_player uuid;
  v_invalid_slot roster_slot_type;
  v_invalid_player text;
  v_invalid_player_slot roster_slot_type;
  v_locked_player text;
  v_slot record;
  v_candidate uuid;
  v_preserve boolean;
  v_projections jsonb;
  v_week_number int;
  v_paths jsonb;
  v_path jsonb;
  v_seen text[];
  v_next record;
  v_repair_players uuid[];
  v_repair_slots text[];
  v_index int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(
    hashtext(p_member_id::text),
    hashtext(p_game_date::text)
  );

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Lineups can only be set during an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSONB array.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_assignments) AS a
     WHERE a->>'player_id' IS NULL
        OR a->>'slot_type' IS NULL
  ) THEN
    RAISE EXCEPTION 'Every lineup assignment must include player_id and slot_type.'
      USING ERRCODE = '22023';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT player_id
    INTO v_duplicate_player
    FROM assignments
   GROUP BY player_id
  HAVING count(*) > 1
   LIMIT 1;

  IF v_duplicate_player IS NOT NULL THEN
    RAISE EXCEPTION 'A player can only appear once in a lineup.'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT (a->>'player_id')::uuid ORDER BY (a->>'player_id')::uuid)
    INTO v_player_ids
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL;

  v_player_ids := COALESCE(v_player_ids, ARRAY[]::uuid[]);

  IF array_length(v_player_ids, 1) IS NOT NULL THEN
    PERFORM 1
       FROM roster_players
      WHERE member_id = p_member_id
        AND league_id = p_league_id
        AND league_season_id = p_league_season_id
        AND player_id = ANY (v_player_ids)
      FOR SHARE;

    SELECT count(*)
      INTO v_owned_count
      FROM unnest(v_player_ids) AS requested(player_id)
     WHERE EXISTS (
       SELECT 1 FROM roster_players rp
        WHERE rp.member_id = p_member_id
          AND rp.league_id = p_league_id
          AND rp.league_season_id = p_league_season_id
          AND rp.player_id = requested.player_id
     ) OR EXISTS (
       SELECT 1
         FROM weekly_lineups wl
         JOIN jsonb_array_elements(p_assignments) AS a
           ON (a->>'player_id')::uuid = wl.player_id
          AND (a->>'slot_type')::roster_slot_type = wl.slot_type
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = requested.player_id
          AND private.lineup_game_started(wl.player_id, wl.game_date)
     );

    v_total_count := array_length(v_player_ids, 1);
    IF v_owned_count <> v_total_count THEN
      RAISE EXCEPTION 'One or more players in the lineup are no longer on your roster.'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT slot_type
    INTO v_invalid_slot
    FROM assignments
   WHERE slot_type = 'IR'::roster_slot_type
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Use the roster injured reserve action instead of assigning an IR lineup slot.'
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1
         FROM lineup_slot_templates t
        WHERE t.league_id = p_league_id
          AND t.slot_type = a.slot_type
          AND t.slot_type NOT IN ('BE'::roster_slot_type, 'IR'::roster_slot_type)
     )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % is not configured for this league.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT a.slot_type
    INTO v_invalid_slot
    FROM assignments a
   WHERE a.slot_type <> 'BE'::roster_slot_type
   GROUP BY a.slot_type
  HAVING count(*) > (
      SELECT t.slot_count
        FROM lineup_slot_templates t
       WHERE t.league_id = p_league_id
         AND t.slot_type = a.slot_type
   )
   LIMIT 1;

  IF v_invalid_slot IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup slot % has too many players.', v_invalid_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name, a.slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM assignments a
    JOIN roster_players rp
      ON rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = a.player_id
    JOIN players p ON p.id = rp.player_id
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND (rp.is_on_ir OR COALESCE(rp.is_on_taxi, false))
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION 'Activate % before assigning a starter slot.', v_invalid_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  ),
  player_slots AS (
    SELECT
      p.display_name,
      a.slot_type,
      CASE
        WHEN cardinality(COALESCE(p.eligible_positions, '{}'::text[])) > 0
          THEN p.eligible_positions
        WHEN p.position IS NOT NULL
          THEN ARRAY[p.position::text]::text[]
        ELSE '{}'::text[]
      END AS eligible_positions,
      public.lineup_slot_allowed_positions(a.slot_type) AS allowed_positions
      FROM assignments a
      JOIN players p ON p.id = a.player_id
     WHERE a.slot_type <> 'BE'::roster_slot_type
  )
  SELECT display_name, slot_type
    INTO v_invalid_player, v_invalid_player_slot
    FROM player_slots
   WHERE NOT (eligible_positions && allowed_positions)
   LIMIT 1;

  IF v_invalid_player IS NOT NULL THEN
    RAISE EXCEPTION '% is not eligible for %.', v_invalid_player, v_invalid_player_slot
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM weekly_lineups wl
    JOIN players p ON p.id = wl.player_id
   WHERE wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND private.lineup_game_started(wl.player_id, wl.game_date)
     AND NOT EXISTS (
       SELECT 1
         FROM assignments a
        WHERE a.player_id = wl.player_id
          AND a.slot_type = wl.slot_type
     )
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked because %''s game has already started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  WITH assignments AS (
    SELECT
      (a->>'player_id')::uuid AS player_id,
      (a->>'slot_type')::roster_slot_type AS slot_type
      FROM jsonb_array_elements(p_assignments) AS a
  )
  SELECT p.display_name
    INTO v_locked_player
    FROM assignments a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN weekly_lineups wl
      ON wl.member_id = p_member_id
     AND wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.game_date = p_game_date
     AND wl.player_id = a.player_id
     AND wl.slot_type = a.slot_type
   WHERE a.slot_type <> 'BE'::roster_slot_type
     AND wl.id IS NULL
     AND private.lineup_game_started(a.player_id, p_game_date)
   LIMIT 1;

  IF v_locked_player IS NOT NULL THEN
    RAISE EXCEPTION 'Lineup changes are locked after %''s game has started.', v_locked_player
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
    INTO p_assignments
    FROM jsonb_array_elements(p_assignments) a
   WHERE a->>'slot_type' <> 'BE';

  IF EXISTS (
    SELECT 1 FROM lineup_slot_templates t
     WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
       AND t.slot_count > (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
         WHERE a->>'slot_type' = t.slot_type::text)
  ) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', projection.player_id,
      'projected', projection.projection_fantasy_points)), '[]'::jsonb)
      INTO v_projections
      FROM public.get_league_projection_rows(
        p_league_id, (SELECT season_year FROM league_seasons WHERE id = p_league_season_id),
        p_game_date, 'today', (SELECT array_agg(player_id) FROM roster_players
          WHERE member_id = p_member_id AND league_id = p_league_id
            AND league_season_id = p_league_season_id AND NOT is_on_ir AND NOT is_on_taxi),
        1000, 0
      ) projection;
    SELECT COALESCE((SELECT week_number FROM season_weeks
      WHERE season_year = (SELECT season_year FROM league_seasons WHERE id = p_league_season_id)
        AND p_game_date BETWEEN week_start AND week_end), 1) INTO v_week_number;

    FOREACH v_preserve IN ARRAY ARRAY[true, false] LOOP
      FOR v_slot IN
        SELECT t.slot_type, sequence.number
          FROM lineup_slot_templates t
          CROSS JOIN LATERAL generate_series(1, t.slot_count) sequence(number)
         WHERE t.league_id = p_league_id AND t.slot_type NOT IN ('BE', 'IR')
         ORDER BY array_position(ARRAY['PG','SG','SF','PF','C','G','F','UTIL'], t.slot_type::text), sequence.number
      LOOP
        IF (SELECT count(*) FROM jsonb_array_elements(p_assignments) a
          WHERE a->>'slot_type' = v_slot.slot_type::text) >= v_slot.number THEN
          CONTINUE;
        END IF;
        WITH stored AS MATERIALIZED (
          SELECT id, player_id FROM weekly_lineups
           WHERE member_id = p_member_id AND league_id = p_league_id
             AND league_season_id = p_league_season_id AND game_date = p_game_date
             AND slot_type = v_slot.slot_type
        )
        SELECT rp.player_id INTO v_candidate
          FROM roster_players rp JOIN players p ON p.id = rp.player_id
          LEFT JOIN stored wl ON wl.player_id = rp.player_id
          LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
            ON projection.player_id = rp.player_id
         WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
           AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
           AND (NOT v_preserve OR wl.id IS NOT NULL)
           AND NOT private.lineup_game_started(rp.player_id, p_game_date)
           AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
             && public.lineup_slot_allowed_positions(v_slot.slot_type)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
             WHERE (a->>'player_id')::uuid = rp.player_id)
         ORDER BY (wl.id IS NOT NULL) DESC,
           EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
             AND private.lineup_game_available(g.status, g.game_status_text)
             AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
           COALESCE(projection.projected, 0) DESC, rp.player_id
         LIMIT 1;
        IF v_candidate IS NULL AND NOT v_preserve THEN
          v_seen := ARRAY[v_slot.slot_type::text];
          v_paths := jsonb_build_array(jsonb_build_object('slots', v_seen, 'players', '[]'::jsonb));
          WHILE jsonb_array_length(v_paths) > 0 LOOP
            v_path := v_paths->0;
            v_paths := v_paths - 0;
            SELECT rp.player_id INTO v_candidate
              FROM roster_players rp JOIN players p ON p.id = rp.player_id
              LEFT JOIN jsonb_to_recordset(v_projections) projection(player_id uuid, projected numeric)
                ON projection.player_id = rp.player_id
             WHERE rp.member_id = p_member_id AND rp.league_id = p_league_id
               AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
               AND NOT private.lineup_game_started(rp.player_id, p_game_date)
               AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                 && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid = rp.player_id)
             ORDER BY EXISTS (SELECT 1 FROM nba_games g WHERE g.game_date = p_game_date
               AND private.lineup_game_available(g.status, g.game_status_text)
               AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)) DESC,
               COALESCE(projection.projected, 0) DESC, rp.player_id
             LIMIT 1;
            IF v_candidate IS NOT NULL THEN
              SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(v_path->'players')) || v_candidate,
                ARRAY(SELECT value FROM jsonb_array_elements_text(v_path->'slots'))
                INTO v_repair_players, v_repair_slots;
              FOR v_index IN 1..cardinality(v_repair_players) LOOP
                SELECT COALESCE(jsonb_agg(a), '[]'::jsonb) INTO p_assignments
                  FROM jsonb_array_elements(p_assignments) a
                 WHERE (a->>'player_id')::uuid <> v_repair_players[v_index];
                p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
                  'player_id', v_repair_players[v_index], 'slot_type', v_repair_slots[v_index],
                  'week_number', v_week_number, 'is_auto_set', true));
              END LOOP;
              v_candidate := NULL;
              EXIT;
            END IF;
            FOR v_next IN
              SELECT (a->>'player_id')::uuid AS player_id, a->>'slot_type' AS slot_type
                FROM jsonb_array_elements(p_assignments) a
                JOIN roster_players rp ON rp.player_id = (a->>'player_id')::uuid
                  AND rp.member_id = p_member_id AND rp.league_id = p_league_id
                  AND rp.league_season_id = p_league_season_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
                JOIN players p ON p.id = rp.player_id
               WHERE NOT (a->>'slot_type' = ANY(v_seen))
                 AND NOT private.lineup_game_started(p.id, p_game_date)
                 AND COALESCE(NULLIF(p.eligible_positions, '{}'::text[]), ARRAY[p.position::text])
                   && public.lineup_slot_allowed_positions((v_path->'slots'->>-1)::roster_slot_type)
               ORDER BY a->>'slot_type', a->>'player_id'
            LOOP
              IF v_next.slot_type = ANY(v_seen) THEN CONTINUE; END IF;
              v_seen := array_append(v_seen, v_next.slot_type);
              v_paths := v_paths || jsonb_build_array(jsonb_build_object(
                'slots', (v_path->'slots') || to_jsonb(v_next.slot_type),
                'players', (v_path->'players') || to_jsonb(v_next.player_id)));
            END LOOP;
          END LOOP;
        END IF;
        IF v_candidate IS NOT NULL THEN
          p_assignments := p_assignments || jsonb_build_array(jsonb_build_object(
            'player_id', v_candidate, 'slot_type', v_slot.slot_type,
            'week_number', v_week_number, 'is_auto_set', true));
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM private.assert_lineup_player_pins(p_league_id, p_league_season_id, p_member_id, p_game_date, p_assignments);

  DELETE FROM weekly_lineups
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND game_date = p_game_date
     AND NOT private.lineup_game_started(player_id, game_date);

  INSERT INTO weekly_lineups (
    member_id,
    league_id,
    league_season_id,
    player_id,
    week_number,
    game_date,
    slot_type,
    is_auto_set,
    set_at
  )
  SELECT
    p_member_id,
    p_league_id,
    p_league_season_id,
    (a->>'player_id')::uuid,
    COALESCE((a->>'week_number')::int, 1),
    p_game_date,
    (a->>'slot_type')::roster_slot_type,
    COALESCE((a->>'is_auto_set')::boolean, true),
    now()
    FROM jsonb_array_elements(p_assignments) AS a
   WHERE a->>'player_id' IS NOT NULL
     AND a->>'slot_type' IS NOT NULL
     AND (a->>'slot_type')::roster_slot_type <> 'BE'::roster_slot_type
     AND NOT EXISTS (
       SELECT 1 FROM weekly_lineups wl
        WHERE wl.member_id = p_member_id
          AND wl.league_id = p_league_id
          AND wl.league_season_id = p_league_season_id
          AND wl.game_date = p_game_date
          AND wl.player_id = (a->>'player_id')::uuid
     );
END;
$function$;

CREATE OR REPLACE FUNCTION private.apply_scheduled_lineup(
  p_game_date date, p_league_id uuid, p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_same boolean;
BEGIN
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_member_id::text), hashtext(p_game_date::text));
  PERFORM 1 FROM public.leagues WHERE id = p_league_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.players WHERE id IN (
    SELECT (a->>'player_id')::uuid FROM jsonb_array_elements(p_assignments) a
  ) ORDER BY id FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE (lower(p.injury_status) = 'out' OR lower(p.injury_status) LIKE 'ir%')
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT private.lineup_game_started(p.id, p_game_date)
  ) THEN
    RAISE EXCEPTION 'Injury status changed; retry with fresh players.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_assignments) a
    JOIN public.players p ON p.id = (a->>'player_id')::uuid
    WHERE NOT private.lineup_game_started(p.id, p_game_date)
      AND COALESCE((a->>'expected_active')::boolean, true)
      AND NOT EXISTS (
        SELECT 1 FROM public.nba_games g
        WHERE g.game_date = p_game_date
          AND private.lineup_game_available(g.status, g.game_status_text)
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
      )
  ) THEN
    RAISE EXCEPTION 'Game schedule changed; retry with fresh games.' USING ERRCODE = '40001';
  END IF;

  PERFORM private.assert_lineup_player_pins(p_league_id, p_league_season_id, p_member_id, p_game_date, p_assignments);

  SELECT NOT EXISTS (
    (SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date
     EXCEPT SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a)
    UNION ALL
    (SELECT (a->>'player_id')::uuid, a->>'slot_type' FROM jsonb_array_elements(p_assignments) a
     EXCEPT SELECT player_id, slot_type::text FROM public.weekly_lineups
      WHERE member_id = p_member_id AND league_id = p_league_id
        AND league_season_id = p_league_season_id AND game_date = p_game_date)
  ) INTO v_same;

  IF NOT v_same THEN
    PERFORM public.auto_set_lineup_service_atomic(p_member_id, p_league_id, p_league_season_id,
      p_game_date, p_assignments);
  END IF;
  RETURN NOT v_same;
END;
$$;

REVOKE ALL ON FUNCTION public.set_lineup_player_pin(uuid, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_lineup_player_pin(uuid, uuid, date, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.clear_roster_lineup_pins() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_lineup_player_pins(uuid, uuid, uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.clear_roster_lineup_pins() TO service_role;
GRANT EXECUTE ON FUNCTION private.assert_lineup_player_pins(uuid, uuid, uuid, date, jsonb) TO service_role;
CREATE TRIGGER clear_roster_lineup_pins AFTER DELETE OR UPDATE OF league_id, league_season_id, member_id, player_id, is_on_ir, is_on_taxi
  ON public.roster_players FOR EACH ROW EXECUTE FUNCTION private.clear_roster_lineup_pins();
CREATE TRIGGER league_version_insert AFTER INSERT ON public.lineup_player_pins
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.lineup_player_pins
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.lineup_player_pins
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER refresh_views_from_lineup_pins AFTER INSERT OR UPDATE OR DELETE ON public.lineup_player_pins
  FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();

COMMIT;
