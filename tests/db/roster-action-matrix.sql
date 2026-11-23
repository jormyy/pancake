BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE matrix_cells (action text, hold text, command text, observed text, PRIMARY KEY (action, hold));

CREATE FUNCTION pg_temp.observe(p_command text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_command;
    RAISE EXCEPTION 'observed' USING ERRCODE = 'PZ999';
  EXCEPTION WHEN SQLSTATE 'PZ999' THEN RETURN 'allowed';
  WHEN OTHERS THEN RETURN SQLSTATE || ' ' || SQLERRM;
  END;
END;
$$;

DO $$
DECLARE
  f record;
  holds text[] := ARRAY['offer_pending','trade_reserved','claim_reserved'];
  active uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  ir uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  taxi uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  partners uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  free_agents uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1,12));
  game_date date := (now() AT TIME ZONE 'America/New_York')::date + 1;
  accepted uuid;
  h integer;
  r uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9395);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9395,1,game_date-2,game_date+5);
  UPDATE public.leagues SET ir_slots=6,taxi_slots=6,roster_size=20,allow_inactive_trades=true WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp,injury_status)
    SELECT id,'Matrix',kind||ordinal,'PG',ARRAY['PG','SG'],'ZMX',0,CASE WHEN kind='ir' THEN 'Out' END
      FROM (SELECT 'active' kind,* FROM unnest(active) WITH ORDINALITY a(id,ordinal)
        UNION ALL SELECT 'ir',* FROM unnest(ir) WITH ORDINALITY a(id,ordinal)
        UNION ALL SELECT 'taxi',* FROM unnest(taxi) WITH ORDINALITY a(id,ordinal)
        UNION ALL SELECT 'partner',* FROM unnest(partners) WITH ORDINALITY a(id,ordinal)
        UNION ALL SELECT 'free',* FROM unnest(free_agents) WITH ORDINALITY a(id,ordinal)) roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
    SELECT f.league_id,f.season_id,f.member_ids[1],id,'draft',kind='ir',kind='taxi'
      FROM (SELECT 'active' kind,unnest(active) id UNION ALL SELECT 'ir',unnest(ir) UNION ALL SELECT 'taxi',unnest(taxi)) roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],partners[1],'draft'),(f.league_id,f.season_id,f.member_ids[3],partners[2],'draft');
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count)
    VALUES(f.league_id,'PG',3),(f.league_id,'SG',1),(f.league_id,'BE',10)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    SELECT f.league_id,f.season_id,f.member_ids[1],id,1,game_date,'PG' FROM unnest(active) id;

  PERFORM public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
    ARRAY[active[1],ir[1],taxi[1]],ARRAY[partners[1]],'{}','{}');
  accepted := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],
    ARRAY[active[2],ir[2],taxi[2]],ARRAY[partners[2]],'{}','{}');
  PERFORM public.accept_trade_atomic(accepted,f.member_ids[3]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM public.trades WHERE id=accepted),'accepted trade holds its assets');
  PERFORM public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],free_agents[1],active[3]);
  PERFORM public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],free_agents[2],ir[3]);
  PERFORM public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],free_agents[3],taxi[3]);

  FOR h IN 1..3 LOOP
    SELECT id INTO r FROM public.roster_players WHERE league_season_id=f.season_id AND player_id=active[h];
    INSERT INTO matrix_cells(action,hold,command) VALUES
      ('drop',holds[h],format('DELETE FROM public.roster_players WHERE id=%L',r)),
      ('lineup_move',holds[h],format('UPDATE public.weekly_lineups SET slot_type=''BE'' WHERE player_id=%L AND game_date=%L',active[h],game_date)),
      ('to_ir',holds[h],format('UPDATE public.roster_players SET is_on_ir=true WHERE id=%L',r)),
      ('to_taxi',holds[h],format('UPDATE public.roster_players SET is_on_taxi=true WHERE id=%L',r)),
      ('transfer',holds[h],format('UPDATE public.roster_players SET member_id=%L WHERE id=%L',f.member_ids[2],r)),
      ('from_ir',holds[h],format('UPDATE public.roster_players SET is_on_ir=false WHERE league_season_id=%L AND player_id=%L',f.season_id,ir[h])),
      ('from_taxi',holds[h],format('UPDATE public.roster_players SET is_on_taxi=false WHERE league_season_id=%L AND player_id=%L',f.season_id,taxi[h])),
      ('claim_drop',holds[h],format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,%L)',f.league_id,f.member_ids[1],free_agents[3+h],active[h])),
      ('trade_offer',holds[h],format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,ARRAY[%L]::uuid[],''{}''::uuid[],''{}'',''{}'')',
        f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],active[h]));
  END LOOP;
  UPDATE matrix_cells SET observed=pg_temp.observe(command);
END;
$$;

DO $$
DECLARE
  failures text;
BEGIN
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.roster_action_policy())
    =(SELECT count(*) FROM (SELECT DISTINCT action,hold FROM private.roster_action_policy()) cell)
    AND (SELECT count(*) FROM private.roster_action_policy())
      =cardinality(enum_range(NULL::private.roster_action))*cardinality(enum_range(NULL::private.roster_hold)),
    'roster_action_policy decides every action and hold exactly once');
  SELECT string_agg(format('(%s, %s) policy %s but the database %s', cell.action, cell.hold,
      COALESCE('blocks with '||policy.errcode,'allows'), cell.observed), E'\n' ORDER BY cell.action, cell.hold)
    INTO failures
    FROM matrix_cells cell
    JOIN private.roster_action_policy() policy ON policy.action::text=cell.action AND policy.hold::text=cell.hold
    WHERE CASE WHEN policy.errcode IS NULL THEN cell.observed<>'allowed'
      ELSE cell.observed NOT LIKE '%Locked by %' END;
  IF failures IS NOT NULL THEN
    RAISE EXCEPTION E'FAIL: roster guards disagree with private.roster_action_policy:\n%\nRoute every hold check through private.assert_roster_action_allowed and change the cell in private.roster_action_policy.', failures;
  END IF;
  PERFORM pg_temp.check_rules((SELECT count(*)=27 FROM matrix_cells WHERE observed IS NOT NULL), 'every exercised cell observed');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
SELECT action, hold, observed FROM matrix_cells ORDER BY action, hold;
ROLLBACK;
