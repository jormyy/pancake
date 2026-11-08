BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE INDEX IF NOT EXISTS public_api_buckets_minute ON private.public_api_buckets(minute);

CREATE OR REPLACE FUNCTION public.public_admit_read(p_client_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1s' SET statement_timeout='2s' AS $$
DECLARE
  used integer;
  current_minute timestamptz:=date_trunc('minute',clock_timestamp());
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status',400); END IF;
  INSERT INTO private.public_api_buckets(bucket_key,minute,reads) VALUES(p_client_key,current_minute,1)
    ON CONFLICT(bucket_key,minute) DO UPDATE SET reads=private.public_api_buckets.reads+1
    WHERE private.public_api_buckets.reads<60 RETURNING reads INTO used;
  IF used IS NULL THEN RETURN jsonb_build_object('status',429,'retryAfter',60); END IF;
  DELETE FROM private.public_api_buckets WHERE (bucket_key,minute) IN (
    SELECT bucket_key,minute FROM private.public_api_buckets WHERE minute<current_minute-interval '2 minutes'
    ORDER BY minute LIMIT 128 FOR UPDATE SKIP LOCKED
  );
  RETURN jsonb_build_object('status',200);
END;
$$;
REVOKE ALL ON FUNCTION public.public_admit_read(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_admit_read(text) TO service_role;

CREATE OR REPLACE FUNCTION public.public_read_v2(p_league_id uuid,p_resource text,p_params jsonb DEFAULT '{}',p_client_key text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET lock_timeout='1s' SET statement_timeout='5s' AS $$
DECLARE
  params jsonb:=coalesce(p_params,'{}');
  page_limit integer;
  page_offset integer;
  selected_season uuid;
  selected_year integer;
  result_rows jsonb;
  more boolean;
  field_name text;
  field_value jsonb;
  filter_spec jsonb:='{"leagues":["query"],"league":["season"],"seasons":[],"teams":["team","query"],"players":["player","query","position"],"free-agents":["player","query","position","season"],"rosters":["team","season"],"standings":["team"],"matchups":["team","week","season"],"scores":["team","week","season"],"schedule":["team","week","season"],"player-stats":["player","query","position","season"],"projections":["player","query","position"],"drafts":["draft","season"],"draft-results":["draft","team","season"],"picks":["team","season"],"trades":["trade","season","team"],"trade-assets":["trade","team"],"transactions":["team","season"]}'::jsonb;
  sort_spec jsonb:='{"leagues":["id","name","status"],"league":["id","name","status","leagueId","seasonId","seasonYear","timezone","rosterSize","irSlots","taxiSlots","taxiRule","taxiMaxSeasons","teamLimit","auctionBudget","waiverMode","faabStartingBudget","weeklyAddLimit","tradeDeadline","tradeVetoMode","tradeVetoWindowHours","tradeVetoThresholdPercent","allowInactiveTrades","playoffStartWeek","playoffEntrants","rookieDraftOrder","futurePickYears","playoffTotalWeeks"],"seasons":["id","leagueId","seasonYear","isCurrent","regularSeasonStart","regularSeasonEnd"],"teams":["id","leagueId","name"],"players":["id","leagueId","name","nbaId","nbaTeam","position","injuryStatus","yearsExperience","status","birthdate","injuryReason","injuryExpectedReturn","nbaDraftNumber","careerGames","headshotUrl"],"free-agents":["id","leagueId","name","nbaId","nbaTeam","position","injuryStatus","yearsExperience","status","availability","waiverClearsAt","waiverEligible","birthdate","injuryReason","injuryExpectedReturn","nbaDraftNumber","careerGames","headshotUrl"],"rosters":["id","leagueId","seasonYear","teamId","isOnIR","isOnTaxi"],"standings":["id","leagueId","name","wins","losses","ties","pointsFor","pointsAgainst","maxPointsFor","rank"],"matchups":["id","leagueId","seasonYear","weekNumber","endWeekNumber","homeTeamId","awayTeamId","homeTeamName","awayTeamName","homePoints","awayPoints","finalized","winnerTeamId"],"scores":["id","leagueId","seasonYear","weekNumber","endWeekNumber","homeTeamId","awayTeamId","homeTeamName","awayTeamName","homePoints","awayPoints","finalized","winnerTeamId"],"schedule":["id","leagueId","seasonYear","weekNumber","endWeekNumber","homeTeamId","awayTeamId","homeTeamName","awayTeamName","homePoints","awayPoints","finalized","winnerTeamId"],"player-stats":["id","leagueId","name","nbaId","nbaTeam","position","injuryStatus","yearsExperience","status","seasonYear","fantasyPoints","gamesPlayed","points","rebounds","assists","steals","blocks","turnovers","threePointersMade","minutes","birthdate","injuryReason","injuryExpectedReturn","nbaDraftNumber","careerGames","headshotUrl","fieldGoalsMade","fieldGoalsAttempted","freeThrowsMade","freeThrowsAttempted","doubleDoubles","tripleDoubles"],"projections":["id","leagueId","name","nbaId","nbaTeam","position","injuryStatus","yearsExperience","status","date","source","fetchedAt","projectionStatus","fantasyPoints","points","rebounds","assists","steals","blocks","turnovers","minutes","birthdate","injuryReason","injuryExpectedReturn","nbaDraftNumber","careerGames","headshotUrl"],"drafts":["id","leagueId","seasonYear","draftType","status","scheduledAt","startedAt","completedAt"],"draft-results":["id","leagueId","seasonYear","draftId","draftType","overallPick","round","teamId","teamName","playerId","playerName","pickedAt","price"],"picks":["id","leagueId","seasonYear","round","teamId","originalTeamId","isUsed"],"trades":["id","leagueId","seasonYear","status","completedAt","proposerTeamId","recipientTeamId"],"trade-assets":["id","leagueId","tradeId","status","completedAt","fromTeamId","toTeamId","kind","playerId","playerName","pickId","pickSeasonYear","pickRound"],"transactions":["id","leagueId","teamId","teamName","playerId","playerName","type","occurredAt","tradeId"]}'::jsonb;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status',400); END IF;
  IF p_resource IS NULL OR NOT (filter_spec ? p_resource) THEN RETURN jsonb_build_object('status',404); END IF;
  IF jsonb_typeof(params)<>'object' THEN RETURN jsonb_build_object('status',400); END IF;
  FOR field_name,field_value IN SELECT key,value FROM jsonb_each(params) LOOP
    IF field_name IN ('team','player','draft','trade') THEN
      IF jsonb_typeof(field_value)<>'string' OR (params->>field_name) !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN jsonb_build_object('status',400); END IF;
      params:=jsonb_set(params,ARRAY[field_name],to_jsonb(lower(params->>field_name)));
    ELSIF field_name IN ('limit','offset','season','week') THEN
      IF jsonb_typeof(field_value) NOT IN ('string','number') OR (params->>field_name) !~ '^[0-9]+$' OR length(params->>field_name)>9 THEN RETURN jsonb_build_object('status',400); END IF;
    ELSE
      IF jsonb_typeof(field_value)<>'string' OR length(params->>field_name)>100 OR (params->>field_name) ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('status',400); END IF;
    END IF;
  END LOOP;
  IF params ? 'season' AND (params->>'season')::integer NOT BETWEEN 1 AND 2200 THEN RETURN jsonb_build_object('status',400); END IF;
  IF params ? 'week' AND (params->>'week')::integer NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('status',400); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(params) k
    WHERE k NOT IN ('limit','offset','sort','direction') AND NOT ((filter_spec->p_resource) ? k)) THEN RETURN jsonb_build_object('status',400); END IF;
  IF params ? 'sort' AND NOT ((sort_spec->p_resource) ? (params->>'sort')) THEN RETURN jsonb_build_object('status',400); END IF;
  IF params ? 'direction' AND params->>'direction' NOT IN ('asc','desc') THEN RETURN jsonb_build_object('status',400); END IF;
  page_limit:=coalesce((params->>'limit')::integer,25);
  page_offset:=coalesce((params->>'offset')::integer,0);
  IF page_limit NOT BETWEEN 1 AND 50 OR page_offset NOT BETWEEN 0 AND 100000 THEN RETURN jsonb_build_object('status',400); END IF;
  IF p_resource<>'leagues' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=p_league_id AND deleted_at IS NULL) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'team' AND NOT EXISTS(SELECT 1 FROM public.league_members WHERE id=(params->>'team')::uuid AND league_id=p_league_id) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'player' AND NOT EXISTS(SELECT 1 FROM public.players WHERE id=(params->>'player')::uuid) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'draft' AND NOT EXISTS(SELECT 1 FROM public.drafts WHERE id=(params->>'draft')::uuid AND league_id=p_league_id AND NOT is_mock) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'trade' AND NOT EXISTS(SELECT 1 FROM public.trades WHERE id=(params->>'trade')::uuid AND league_id=p_league_id AND status='completed' AND completed_at IS NOT NULL) THEN RETURN jsonb_build_object('status',404); END IF;
  SELECT id,season_year INTO selected_season,selected_year FROM public.league_seasons
    WHERE league_id=p_league_id AND (params->>'season' IS NULL OR season_year=(params->>'season')::integer)
    ORDER BY is_current DESC,season_year DESC,id LIMIT 1;
  selected_year:=coalesce((params->>'season')::integer,selected_year,public.current_season_year_et());
  CASE p_resource
    WHEN 'leagues' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          l.id,
          'name',
          to_jsonb(left((l.name)::text,1024)),
          'status',
          l.status::text) AS data
        FROM public.leagues l
        WHERE (l.deleted_at IS NULL) AND l.deleted_at IS NULL
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0)
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'league' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          l.id,
          'name',
          to_jsonb(left((l.name)::text,1024)),
          'status',
          l.status::text,
          'leagueId',
          l.id,
          'seasonId',
          selected_season,
          'seasonYear',
          selected_year,
          'timezone',
          to_jsonb(left((l.timezone)::text,1024)),
          'rosterSize',
          l.roster_size,
          'irSlots',
          l.ir_slots,
          'taxiSlots',
          l.taxi_slots,
          'taxiRule',
          l.taxi_rule,
          'taxiMaxSeasons',
          l.taxi_max_seasons,
          'teamLimit',
          l.team_limit,
          'auctionBudget',
          l.auction_budget,
          'waiverMode',
          l.waiver_mode,
          'faabStartingBudget',
          l.faab_starting_budget,
          'weeklyAddLimit',
          l.weekly_add_limit,
          'tradeDeadline',
          l.trade_deadline,
          'tradeVetoMode',
          l.trade_veto_mode,
          'tradeVetoWindowHours',
          l.trade_veto_window_hours,
          'tradeVetoThresholdPercent',
          l.trade_veto_threshold_percent,
          'allowInactiveTrades',
          l.allow_inactive_trades,
          'playoffStartWeek',
          l.playoff_start_week,
          'playoffEntrants',
          l.playoff_entrants,
          'rookieDraftOrder',
          l.rookie_draft_order,
          'futurePickYears',
          l.future_pick_years,
          'scoringSettings',
          (SELECT jsonb_build_object('points',bounded.value->'points','rebounds',bounded.value->'rebounds','assists',bounded.value->'assists','steals',bounded.value->'steals','blocks',bounded.value->'blocks','turnovers',bounded.value->'turnovers','three_pointers_made',bounded.value->'three_pointers_made','field_goals_made',bounded.value->'field_goals_made','field_goals_attempted',bounded.value->'field_goals_attempted','free_throws_made',bounded.value->'free_throws_made','free_throws_attempted',bounded.value->'free_throws_attempted','double_double',bounded.value->'double_double','triple_double',bounded.value->'triple_double') FROM (SELECT to_jsonb(jsonb_build_object('points',l.scoring_settings->'points','rebounds',l.scoring_settings->'rebounds','assists',l.scoring_settings->'assists','steals',l.scoring_settings->'steals','blocks',l.scoring_settings->'blocks','turnovers',l.scoring_settings->'turnovers','three_pointers_made',l.scoring_settings->'three_pointers_made','field_goals_made',l.scoring_settings->'field_goals_made','field_goals_attempted',l.scoring_settings->'field_goals_attempted','free_throws_made',l.scoring_settings->'free_throws_made','free_throws_attempted',l.scoring_settings->'free_throws_attempted','double_double',l.scoring_settings->'double_double','triple_double',l.scoring_settings->'triple_double')) AS value OFFSET 0) bounded),
          'playoffRoundLengths',
          CASE WHEN to_jsonb(l.playoff_round_lengths) IS NULL OR to_jsonb(l.playoff_round_lengths)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(element.value ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(l.playoff_round_lengths)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=20) END,
          'playoffRoundWeeks',
          CASE WHEN to_jsonb(l.playoff_round_weeks) IS NULL OR to_jsonb(l.playoff_round_weeks)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(element.value ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(l.playoff_round_weeks)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=20) END,
          'playoffTotalWeeks',
          l.playoff_total_weeks,
          'lineupSlots',
          (SELECT coalesce(jsonb_agg((SELECT jsonb_build_object('slotType',bounded.value->'slotType','slotCount',bounded.value->'slotCount') FROM (SELECT element.value AS value OFFSET 0) bounded) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(coalesce((SELECT jsonb_agg(jsonb_build_object('slotType',slot.slot_type,'slotCount',slot.slot_count) ORDER BY slot.slot_type) FROM public.lineup_slot_templates slot WHERE slot.league_id=l.id),'[]'::jsonb))) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=20),
          'waiverOrder',
          (SELECT coalesce(jsonb_agg((SELECT jsonb_build_object('teamId',bounded.value->'teamId','priority',bounded.value->'priority') FROM (SELECT element.value AS value OFFSET 0) bounded) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(coalesce((SELECT jsonb_agg(jsonb_build_object('teamId',w.member_id,'priority',w.priority) ORDER BY w.priority,w.member_id) FROM public.waiver_priorities w JOIN public.league_members member ON member.id=w.member_id AND member.league_id=w.league_id WHERE w.league_id=l.id AND w.league_season_id=selected_season),'[]'::jsonb))) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=100)) AS data
        FROM public.leagues l
        WHERE (l.deleted_at IS NULL AND l.id=p_league_id)
      ), filtered AS (
        SELECT data FROM visible WHERE true
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'seasons' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          s.id,
          'leagueId',
          s.league_id,
          'seasonYear',
          s.season_year,
          'isCurrent',
          s.is_current,
          'regularSeasonStart',
          s.regular_season_start,
          'regularSeasonEnd',
          s.regular_season_end) AS data
        FROM public.league_seasons s
        WHERE (s.league_id=p_league_id)
      ), filtered AS (
        SELECT data FROM visible WHERE true
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'teams' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          m.id,
          'leagueId',
          m.league_id,
          'name',
          coalesce(m.team_name,'Team')) AS data
        FROM public.league_members m
        WHERE (m.league_id=p_league_id)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'id'=params->>'team') AND (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0)
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'players' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          p.id,
          'leagueId',
          p_league_id,
          'name',
          to_jsonb(left((p.display_name)::text,1024)),
          'nbaId',
          to_jsonb(left((p.nba_id)::text,1024)),
          'nbaTeam',
          to_jsonb(left((p.nba_team)::text,1024)),
          'position',
          p.position::text,
          'injuryStatus',
          to_jsonb(left((p.injury_status)::text,1024)),
          'yearsExperience',
          p.years_exp,
          'status',
          to_jsonb(left((p.status)::text,1024)),
          'birthdate',
          p.birthdate,
          'injuryReason',
          to_jsonb(left((p.injury_reason)::text,1024)),
          'injuryExpectedReturn',
          to_jsonb(left((p.injury_expected_return)::text,1024)),
          'nbaDraftNumber',
          p.nba_draft_number,
          'careerGames',
          p.career_regular_season_games,
          'headshotUrl',
          to_jsonb(left((p.headshot_url)::text,1024)),
          'eligiblePositions',
          CASE WHEN to_jsonb(p.eligible_positions) IS NULL OR to_jsonb(p.eligible_positions)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(to_jsonb(left((element.value #>> '{}'),32)) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(p.eligible_positions)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=10) END) AS data
        FROM public.players p
        WHERE (true)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'player' IS NULL OR data->>'id'=params->>'player') AND (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0) AND (params->>'position' IS NULL OR data->>'position'=params->>'position')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'free-agents' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          p.id,
          'leagueId',
          p_league_id,
          'name',
          to_jsonb(left((p.display_name)::text,1024)),
          'nbaId',
          to_jsonb(left((p.nba_id)::text,1024)),
          'nbaTeam',
          to_jsonb(left((p.nba_team)::text,1024)),
          'position',
          p.position::text,
          'injuryStatus',
          to_jsonb(left((p.injury_status)::text,1024)),
          'yearsExperience',
          p.years_exp,
          'status',
          to_jsonb(left((p.status)::text,1024)),
          'availability',
          CASE WHEN hold.clears_at IS NULL THEN 'free-agent' ELSE 'waivers' END,
          'waiverClearsAt',
          hold.clears_at,
          'waiverEligible',
          true,
          'birthdate',
          p.birthdate,
          'injuryReason',
          to_jsonb(left((p.injury_reason)::text,1024)),
          'injuryExpectedReturn',
          to_jsonb(left((p.injury_expected_return)::text,1024)),
          'nbaDraftNumber',
          p.nba_draft_number,
          'careerGames',
          p.career_regular_season_games,
          'headshotUrl',
          to_jsonb(left((p.headshot_url)::text,1024)),
          'eligiblePositions',
          CASE WHEN to_jsonb(p.eligible_positions) IS NULL OR to_jsonb(p.eligible_positions)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(to_jsonb(left((element.value #>> '{}'),32)) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(p.eligible_positions)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=10) END) AS data
        FROM public.players p LEFT JOIN public.roster_players r ON r.player_id=p.id AND r.league_id=p_league_id AND r.league_season_id=selected_season LEFT JOIN LATERAL (SELECT max(w.clears_at) AS clears_at FROM public.waiver_wire_log w WHERE w.player_id=p.id AND w.league_id=p_league_id AND w.league_season_id=selected_season AND w.cleared_at IS NULL AND w.clears_at>now()) hold ON true
        WHERE (r.id IS NULL)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'player' IS NULL OR data->>'id'=params->>'player') AND (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0) AND (params->>'position' IS NULL OR data->>'position'=params->>'position')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'rosters' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          r.id,
          'leagueId',
          r.league_id,
          'seasonYear',
          selected_year,
          'teamId',
          r.member_id,
          'isOnIR',
          r.is_on_ir,
          'isOnTaxi',
          r.is_on_taxi,
          'player',
          (SELECT jsonb_build_object('id',bounded.value->'id','name',to_jsonb(left((bounded.value->'name' #>> '{}'),1024)),'nbaId',to_jsonb(left((bounded.value->'nbaId' #>> '{}'),1024)),'nbaTeam',to_jsonb(left((bounded.value->'nbaTeam' #>> '{}'),1024)),'position',bounded.value->'position','injuryStatus',to_jsonb(left((bounded.value->'injuryStatus' #>> '{}'),1024)),'yearsExperience',bounded.value->'yearsExperience','status',to_jsonb(left((bounded.value->'status' #>> '{}'),1024)),'birthdate',bounded.value->'birthdate','injuryReason',to_jsonb(left((bounded.value->'injuryReason' #>> '{}'),1024)),'injuryExpectedReturn',to_jsonb(left((bounded.value->'injuryExpectedReturn' #>> '{}'),1024)),'nbaDraftNumber',bounded.value->'nbaDraftNumber','careerGames',bounded.value->'careerGames','headshotUrl',to_jsonb(left((bounded.value->'headshotUrl' #>> '{}'),1024)),'eligiblePositions',CASE WHEN bounded.value->'eligiblePositions' IS NULL OR bounded.value->'eligiblePositions'='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(to_jsonb(left((element.value #>> '{}'),32)) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(bounded.value->'eligiblePositions') WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=10) END) FROM (SELECT to_jsonb(jsonb_build_object('id',p.id,'name',p.display_name,'nbaId',p.nba_id,'nbaTeam',p.nba_team,'position',p.position::text,'injuryStatus',p.injury_status,'yearsExperience',p.years_exp,'status',p.status,'birthdate',p.birthdate,'injuryReason',p.injury_reason,'injuryExpectedReturn',p.injury_expected_return,'nbaDraftNumber',p.nba_draft_number,'careerGames',p.career_regular_season_games,'headshotUrl',p.headshot_url,'eligiblePositions',p.eligible_positions)) AS value OFFSET 0) bounded)) AS data
        FROM public.roster_players r JOIN public.players p ON p.id=r.player_id JOIN public.league_members m ON m.id=r.member_id AND m.league_id=r.league_id
        WHERE (r.league_id=p_league_id AND r.league_season_id=selected_season)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'teamId'=params->>'team')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'standings' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          m.id,
          'leagueId',
          m.league_id,
          'name',
          coalesce(m.team_name,'Team'),
          'wins',
          coalesce(c.wins,0),
          'losses',
          coalesce(c.losses,0),
          'ties',
          coalesce(c.ties,0),
          'pointsFor',
          coalesce(c.points_for,0),
          'pointsAgainst',
          coalesce(c.points_against,0),
          'maxPointsFor',
          coalesce(c.max_points_for,0),
          'rank',
          row_number() OVER (ORDER BY (coalesce(c.wins,0)+0.5*coalesce(c.ties,0))/greatest(coalesce(c.wins+c.losses+c.ties,0),1) DESC,coalesce(c.points_for,0)/greatest(coalesce(c.wins+c.losses+c.ties,0),1) DESC,coalesce(c.max_points_for,0) DESC,coalesce(c.points_against,0),m.team_name,m.id)) AS data
        FROM public.league_members m LEFT JOIN public.standings_current c ON c.member_id=m.id AND c.league_season_id=selected_season
        WHERE (m.league_id=p_league_id)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'id'=params->>'team')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','rank'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','rank'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','rank'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','rank'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'matchups' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          m.id,
          'leagueId',
          m.league_id,
          'seasonYear',
          selected_year,
          'weekNumber',
          m.week_number,
          'endWeekNumber',
          coalesce(m.end_week_number,m.week_number),
          'homeTeamId',
          m.home_member_id,
          'awayTeamId',
          m.away_member_id,
          'homeTeamName',
          h.team_name,
          'awayTeamName',
          a.team_name,
          'homePoints',
          m.home_points,
          'awayPoints',
          m.away_points,
          'finalized',
          m.is_finalized,
          'winnerTeamId',
          m.winner_member_id) AS data
        FROM public.matchups m JOIN public.league_members h ON h.id=m.home_member_id AND h.league_id=m.league_id JOIN public.league_members a ON a.id=m.away_member_id AND a.league_id=m.league_id
        WHERE (m.league_id=p_league_id AND m.league_season_id=selected_season AND NOT m.is_voided) AND m.is_voided=false
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'homeTeamId'=params->>'team' OR data->>'awayTeamId'=params->>'team') AND (params->>'week' IS NULL OR (params->>'week')::integer BETWEEN (data->>'weekNumber')::integer AND (data->>'endWeekNumber')::integer)
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'scores' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          m.id,
          'leagueId',
          m.league_id,
          'seasonYear',
          selected_year,
          'weekNumber',
          m.week_number,
          'endWeekNumber',
          coalesce(m.end_week_number,m.week_number),
          'homeTeamId',
          m.home_member_id,
          'awayTeamId',
          m.away_member_id,
          'homeTeamName',
          h.team_name,
          'awayTeamName',
          a.team_name,
          'homePoints',
          m.home_points,
          'awayPoints',
          m.away_points,
          'finalized',
          m.is_finalized,
          'winnerTeamId',
          m.winner_member_id) AS data
        FROM public.matchups m JOIN public.league_members h ON h.id=m.home_member_id AND h.league_id=m.league_id JOIN public.league_members a ON a.id=m.away_member_id AND a.league_id=m.league_id
        WHERE (m.league_id=p_league_id AND m.league_season_id=selected_season AND NOT m.is_voided) AND m.is_voided=false
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'homeTeamId'=params->>'team' OR data->>'awayTeamId'=params->>'team') AND (params->>'week' IS NULL OR (params->>'week')::integer BETWEEN (data->>'weekNumber')::integer AND (data->>'endWeekNumber')::integer)
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'schedule' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          m.id,
          'leagueId',
          m.league_id,
          'seasonYear',
          selected_year,
          'weekNumber',
          m.week_number,
          'endWeekNumber',
          coalesce(m.end_week_number,m.week_number),
          'homeTeamId',
          m.home_member_id,
          'awayTeamId',
          m.away_member_id,
          'homeTeamName',
          h.team_name,
          'awayTeamName',
          a.team_name,
          'homePoints',
          m.home_points,
          'awayPoints',
          m.away_points,
          'finalized',
          m.is_finalized,
          'winnerTeamId',
          m.winner_member_id) AS data
        FROM public.matchups m JOIN public.league_members h ON h.id=m.home_member_id AND h.league_id=m.league_id JOIN public.league_members a ON a.id=m.away_member_id AND a.league_id=m.league_id
        WHERE (m.league_id=p_league_id AND m.league_season_id=selected_season AND NOT m.is_voided) AND m.is_voided=false
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'homeTeamId'=params->>'team' OR data->>'awayTeamId'=params->>'team') AND (params->>'week' IS NULL OR (params->>'week')::integer BETWEEN (data->>'weekNumber')::integer AND (data->>'endWeekNumber')::integer)
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','weekNumber'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'player-stats' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          p.id,
          'leagueId',
          p_league_id,
          'name',
          to_jsonb(left((p.display_name)::text,1024)),
          'nbaId',
          to_jsonb(left((p.nba_id)::text,1024)),
          'nbaTeam',
          to_jsonb(left((p.nba_team)::text,1024)),
          'position',
          p.position::text,
          'injuryStatus',
          to_jsonb(left((p.injury_status)::text,1024)),
          'yearsExperience',
          p.years_exp,
          'status',
          to_jsonb(left((p.status)::text,1024)),
          'seasonYear',
          selected_year,
          'fantasyPoints',
          coalesce(c.avg_fantasy_points,fp.avg_fantasy_points),
          'gamesPlayed',
          coalesce((c.averages->>'games_played')::integer,a.games_played),
          'points',
          coalesce((c.averages->>'avg_points')::numeric,a.avg_points),
          'rebounds',
          coalesce((c.averages->>'avg_rebounds')::numeric,a.avg_rebounds),
          'assists',
          coalesce((c.averages->>'avg_assists')::numeric,a.avg_assists),
          'steals',
          coalesce((c.averages->>'avg_steals')::numeric,a.avg_steals),
          'blocks',
          coalesce((c.averages->>'avg_blocks')::numeric,a.avg_blocks),
          'turnovers',
          coalesce((c.averages->>'avg_turnovers')::numeric,a.avg_turnovers),
          'threePointersMade',
          coalesce((c.averages->>'avg_three_pointers_made')::numeric,a.avg_three_pointers_made),
          'minutes',
          coalesce((c.averages->>'avg_minutes_played')::numeric,a.avg_minutes_played),
          'birthdate',
          p.birthdate,
          'injuryReason',
          to_jsonb(left((p.injury_reason)::text,1024)),
          'injuryExpectedReturn',
          to_jsonb(left((p.injury_expected_return)::text,1024)),
          'nbaDraftNumber',
          p.nba_draft_number,
          'careerGames',
          p.career_regular_season_games,
          'headshotUrl',
          to_jsonb(left((p.headshot_url)::text,1024)),
          'eligiblePositions',
          CASE WHEN to_jsonb(p.eligible_positions) IS NULL OR to_jsonb(p.eligible_positions)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(to_jsonb(left((element.value #>> '{}'),32)) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(p.eligible_positions)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=10) END,
          'fieldGoalsMade',
          coalesce((c.averages->>'avg_field_goals_made')::numeric,a.avg_field_goals_made),
          'fieldGoalsAttempted',
          coalesce((c.averages->>'avg_field_goals_attempted')::numeric,a.avg_field_goals_attempted),
          'freeThrowsMade',
          coalesce((c.averages->>'avg_free_throws_made')::numeric,a.avg_free_throws_made),
          'freeThrowsAttempted',
          coalesce((c.averages->>'avg_free_throws_attempted')::numeric,a.avg_free_throws_attempted),
          'doubleDoubles',
          coalesce((c.averages->>'double_doubles')::numeric,a.double_doubles),
          'tripleDoubles',
          coalesce((c.averages->>'triple_doubles')::numeric,a.triple_doubles)) AS data
        FROM public.players p LEFT JOIN public.player_season_averages c ON c.player_id=p.id AND c.league_id=p_league_id AND c.season_year=selected_year LEFT JOIN public.mv_player_season_averages a ON a.player_id=p.id AND a.season_year=selected_year LEFT JOIN public.v_player_avg_fantasy_points fp ON fp.player_id=p.id AND fp.league_id=p_league_id AND fp.season_year=selected_year
        WHERE (true)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'player' IS NULL OR data->>'id'=params->>'player') AND (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0) AND (params->>'position' IS NULL OR data->>'position'=params->>'position')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'projections' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          p.id,
          'leagueId',
          p_league_id,
          'name',
          to_jsonb(left((p.display_name)::text,1024)),
          'nbaId',
          to_jsonb(left((p.nba_id)::text,1024)),
          'nbaTeam',
          to_jsonb(left((p.nba_team)::text,1024)),
          'position',
          p.position::text,
          'injuryStatus',
          to_jsonb(left((p.injury_status)::text,1024)),
          'yearsExperience',
          p.years_exp,
          'status',
          to_jsonb(left((p.status)::text,1024)),
          'date',
          pr.projection_date,
          'source',
          to_jsonb(left((pr.projection_source)::text,1024)),
          'fetchedAt',
          pr.projection_fetched_at,
          'projectionStatus',
          to_jsonb(left((pr.projection_status)::text,1024)),
          'fantasyPoints',
          pr.projection_fantasy_points,
          'points',
          pr.projection_points,
          'rebounds',
          pr.projection_rebounds,
          'assists',
          pr.projection_assists,
          'steals',
          pr.projection_steals,
          'blocks',
          pr.projection_blocks,
          'turnovers',
          pr.projection_turnovers,
          'minutes',
          pr.projection_minutes,
          'birthdate',
          p.birthdate,
          'injuryReason',
          to_jsonb(left((p.injury_reason)::text,1024)),
          'injuryExpectedReturn',
          to_jsonb(left((p.injury_expected_return)::text,1024)),
          'nbaDraftNumber',
          p.nba_draft_number,
          'careerGames',
          p.career_regular_season_games,
          'headshotUrl',
          to_jsonb(left((p.headshot_url)::text,1024)),
          'eligiblePositions',
          CASE WHEN to_jsonb(p.eligible_positions) IS NULL OR to_jsonb(p.eligible_positions)='null'::jsonb THEN NULL ELSE (SELECT coalesce(jsonb_agg(to_jsonb(left((element.value #>> '{}'),32)) ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(p.eligible_positions)) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=10) END) AS data
        FROM public.players p LEFT JOIN LATERAL public.get_league_projection_rows(p_league_id,selected_year,(now() AT TIME ZONE 'America/New_York')::date,'today',ARRAY[p.id],1,0) pr ON true
        WHERE (true)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'player' IS NULL OR data->>'id'=params->>'player') AND (params->>'query' IS NULL OR position(lower(params->>'query') IN lower(data->>'name'))>0) AND (params->>'position' IS NULL OR data->>'position'=params->>'position')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','name'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'drafts' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          d.id,
          'leagueId',
          d.league_id,
          'seasonYear',
          selected_year,
          'draftType',
          d.draft_type::text,
          'status',
          d.status::text,
          'scheduledAt',
          d.scheduled_at,
          'startedAt',
          d.started_at,
          'completedAt',
          d.completed_at) AS data
        FROM public.drafts d
        WHERE (d.league_id=p_league_id AND d.league_season_id=selected_season AND NOT d.is_mock) AND d.is_mock=false
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'draft' IS NULL OR data->>'id'=params->>'draft')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','id'),'null'::jsonb) END DESC NULLS LAST LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'draft-results' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          pick.id,
          'leagueId',
          d.league_id,
          'seasonYear',
          selected_year,
          'draftId',
          d.id,
          'draftType',
          d.draft_type::text,
          'overallPick',
          pick.overall_pick,
          'round',
          pick.round,
          'teamId',
          pick.member_id,
          'teamName',
          m.team_name,
          'playerId',
          p.id,
          'playerName',
          to_jsonb(left((p.display_name)::text,1024)),
          'pickedAt',
          pick.picked_at,
          'price',
          pick.price) AS data
        FROM (SELECT s.id,s.draft_id,s.member_id,s.player_id,s.overall_pick,s.round,s.picked_at,NULL::integer AS price FROM public.snake_draft_picks s WHERE s.player_id IS NOT NULL AND s.picked_at IS NOT NULL UNION ALL SELECT n.id,n.draft_id,n.winning_member_id,n.player_id,n.nomination_order,NULL::integer,n.closed_at,n.final_price FROM public.nominations n WHERE n.status='sold' AND n.winning_member_id IS NOT NULL) pick JOIN public.drafts d ON d.id=pick.draft_id JOIN public.players p ON p.id=pick.player_id JOIN public.league_members m ON m.id=pick.member_id AND m.league_id=d.league_id
        WHERE (d.league_id=p_league_id AND d.league_season_id=selected_season AND NOT d.is_mock AND d.status='completed') AND d.is_mock=false AND d.status='completed'
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'draft' IS NULL OR data->>'draftId'=params->>'draft') AND (params->>'team' IS NULL OR data->>'teamId'=params->>'team')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','draftId'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','draftId'),'null'::jsonb) END DESC NULLS LAST, data->'overallPick' ASC, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','draftId'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','draftId'),'null'::jsonb) END DESC NULLS LAST, data->'overallPick' ASC, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'picks' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          p.id,
          'leagueId',
          p.league_id,
          'seasonYear',
          p.season_year,
          'round',
          p.round,
          'teamId',
          p.current_owner_id,
          'originalTeamId',
          p.original_owner_id,
          'isUsed',
          p.is_used) AS data
        FROM public.draft_picks p
        WHERE (p.league_id=p_league_id)
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'teamId'=params->>'team') AND (params->>'season' IS NULL OR data->>'seasonYear'=params->>'season')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END DESC NULLS LAST, data->'round' ASC, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','seasonYear'),'null'::jsonb) END DESC NULLS LAST, data->'round' ASC, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'trades' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          t.id,
          'leagueId',
          t.league_id,
          'seasonYear',
          s.season_year,
          'status',
          t.status::text,
          'completedAt',
          t.completed_at,
          'proposerTeamId',
          t.proposer_member_id,
          'recipientTeamId',
          t.recipient_member_id,
          'teamIds',
          (SELECT coalesce(jsonb_agg(element.value ORDER BY element.ordinality),'[]'::jsonb) FROM jsonb_array_elements(to_jsonb(ARRAY(SELECT participant.member_id::text FROM public.trade_participants participant WHERE participant.trade_id=t.id AND participant.league_id=t.league_id ORDER BY participant.member_id))) WITH ORDINALITY element(value,ordinality) WHERE element.ordinality<=12)) AS data
        FROM public.trades t JOIN public.league_seasons s ON s.id=t.league_season_id AND s.league_id=t.league_id
        WHERE (t.league_id=p_league_id AND t.status='completed' AND t.completed_at IS NOT NULL) AND t.status='completed' AND t.completed_at IS NOT NULL
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'trade' IS NULL OR data->>'id'=params->>'trade') AND (params->>'season' IS NULL OR data->>'seasonYear'=params->>'season') AND (params->>'team' IS NULL OR data->>'proposerTeamId'=params->>'team' OR data->>'recipientTeamId'=params->>'team' OR (data->'teamIds') ? (params->>'team'))
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','desc')='asc' THEN nullif(data->COALESCE(params->>'sort','completedAt'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','desc')='desc' THEN nullif(data->COALESCE(params->>'sort','completedAt'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','desc')='asc' THEN nullif(data->COALESCE(params->>'sort','completedAt'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','desc')='desc' THEN nullif(data->COALESCE(params->>'sort','completedAt'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'trade-assets' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          i.id,
          'leagueId',
          i.league_id,
          'tradeId',
          i.trade_id,
          'status',
          t.status::text,
          'completedAt',
          t.completed_at,
          'fromTeamId',
          i.from_member_id,
          'toTeamId',
          i.to_member_id,
          'kind',
          CASE WHEN i.player_id IS NOT NULL THEN 'player' WHEN i.pick_id IS NOT NULL THEN 'pick' ELSE 'budget' END,
          'playerId',
          i.player_id,
          'playerName',
          to_jsonb(left((p.display_name)::text,1024)),
          'pickId',
          i.pick_id,
          'pickSeasonYear',
          pick.season_year,
          'pickRound',
          pick.round) AS data
        FROM public.trade_items i JOIN public.trades t ON t.id=i.trade_id AND t.league_id=i.league_id JOIN public.league_seasons s ON s.id=t.league_season_id AND s.league_id=t.league_id LEFT JOIN public.players p ON p.id=i.player_id LEFT JOIN public.draft_picks pick ON pick.id=i.pick_id AND pick.league_id=i.league_id
        WHERE (t.league_id=p_league_id AND t.status='completed' AND t.completed_at IS NOT NULL) AND t.status='completed' AND t.completed_at IS NOT NULL
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'trade' IS NULL OR data->>'tradeId'=params->>'trade') AND (params->>'team' IS NULL OR data->>'fromTeamId'=params->>'team' OR data->>'toTeamId'=params->>'team')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','tradeId'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','tradeId'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','asc')='asc' THEN nullif(data->COALESCE(params->>'sort','tradeId'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','asc')='desc' THEN nullif(data->COALESCE(params->>'sort','tradeId'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
    WHEN 'transactions' THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object('id',
          tx.id,
          'leagueId',
          tx.league_id,
          'teamId',
          tx.member_id,
          'teamName',
          m.team_name,
          'playerId',
          tx.player_id,
          'playerName',
          to_jsonb(left((p.display_name)::text,1024)),
          'type',
          tx.transaction_type,
          'occurredAt',
          tx.occurred_at,
          'tradeId',
          CASE WHEN tx.transaction_type IN ('trade_in','trade_out','trade_completed') THEN tx.related_trade_id END) AS data
        FROM (SELECT tx.id,tx.league_id,tx.league_season_id,tx.member_id,tx.player_id,tx.transaction_type,tx.occurred_at,tx.related_trade_id FROM public.roster_transactions tx WHERE tx.transaction_type IN ('fa_add','fa_drop','waiver_add','waiver_drop','trade_in','trade_out','draft_won','carry_over') AND (tx.transaction_type NOT IN ('trade_in','trade_out') OR EXISTS(SELECT 1 FROM public.trades t WHERE t.id=tx.related_trade_id AND t.league_id=tx.league_id AND t.status='completed' AND t.completed_at IS NOT NULL)) UNION ALL SELECT a.id,a.league_id,a.league_season_id,a.actor_member_id,a.related_player_id,a.event_type,a.created_at,a.related_trade_id FROM public.league_activity a JOIN public.trades t ON t.id=a.related_trade_id AND t.league_id=a.league_id AND t.status='completed' AND t.completed_at IS NOT NULL WHERE a.event_type='trade_completed') tx LEFT JOIN public.players p ON p.id=tx.player_id LEFT JOIN public.league_members m ON m.id=tx.member_id AND m.league_id=tx.league_id
        WHERE (tx.league_id=p_league_id AND tx.league_season_id=selected_season) AND tx.transaction_type IN ('fa_add','fa_drop','waiver_add','waiver_drop','trade_in','trade_out','draft_won','carry_over','trade_completed') AND (tx.transaction_type NOT IN ('trade_in','trade_out','trade_completed') OR EXISTS(SELECT 1 FROM public.trades policy_trade WHERE policy_trade.id=tx.related_trade_id AND policy_trade.league_id=tx.league_id AND policy_trade.status='completed' AND policy_trade.completed_at IS NOT NULL))
      ), filtered AS (
        SELECT data FROM visible WHERE (params->>'team' IS NULL OR data->>'teamId'=params->>'team')
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY CASE WHEN COALESCE(params->>'direction','desc')='asc' THEN nullif(data->COALESCE(params->>'sort','occurredAt'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','desc')='desc' THEN nullif(data->COALESCE(params->>'sort','occurredAt'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC) AS ordinal
        FROM filtered ORDER BY CASE WHEN COALESCE(params->>'direction','desc')='asc' THEN nullif(data->COALESCE(params->>'sort','occurredAt'),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction','desc')='desc' THEN nullif(data->COALESCE(params->>'sort','occurredAt'),'null'::jsonb) END DESC NULLS LAST, data->'id' ASC LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;
  END CASE;
  RETURN jsonb_build_object('status',200,'items',result_rows,'hasMore',more);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN jsonb_build_object('status',400);
END;
$$;
REVOKE ALL ON FUNCTION public.public_read_v2(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_read_v2(uuid,text,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
