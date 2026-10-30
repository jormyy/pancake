SET LOCAL statement_timeout='90s';
SET LOCAL lock_timeout='5s';
SET LOCAL app.supabase_url='http://127.0.0.1:64421';
SET LOCAL app.edge_internal_token='roster-actions-local';
SET LOCAL pg_stat_statements.track='none';
SET LOCAL roster_actions.uuid='0';
CREATE FUNCTION pg_temp.ra_uuid() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE n int:=coalesce(nullif(current_setting('roster_actions.uuid',true),''),'0')::int+1;
BEGIN
  PERFORM set_config('roster_actions.uuid',n::text,true);
  RETURN md5('roster-actions-uuid-'||n)::uuid;
END;
$$;
CREATE OR REPLACE FUNCTION pg_catalog.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT pg_temp.ra_uuid() $$;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT pg_temp.ra_uuid() $$;
CREATE OR REPLACE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now() $$;
CREATE OR REPLACE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT pg_temp.ra_uuid() $$;
CREATE TEMP TABLE ra_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9881);
GRANT SELECT ON ra_fixture TO authenticated,service_role;
UPDATE public.leagues SET roster_size=12,ir_slots=4,taxi_slots=4,weekly_add_limit=20,allow_inactive_trades=true WHERE id=(SELECT league_id FROM ra_fixture);
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9881,1,current_date-2,current_date+4);
INSERT INTO public.nba_games(id,season_year,week_number,game_date,home_team,away_team,status,game_time) VALUES(md5('ra-other-game')::uuid,9881,1,(now() AT TIME ZONE 'America/New_York')::date,'ZRC','ZRD','InProgress',now()-interval '1 hour');
INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) SELECT league_id,'PG',4 FROM ra_fixture
  ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
CREATE TEMP TABLE ra_players AS SELECT player_id,((row_number() OVER(ORDER BY games DESC,player_id)-1)/12+1)::int AS manager,((row_number() OVER(ORDER BY games DESC,player_id)-1)%12+1)::int AS ordinal FROM (SELECT player_id,count(*) AS games FROM public.player_game_stats GROUP BY player_id ORDER BY games DESC,player_id LIMIT 36) players;
GRANT SELECT ON ra_players TO authenticated,service_role;
SET LOCAL session_replication_role=replica;
UPDATE public.players SET position='PG',eligible_positions=ARRAY['PG'],nba_team='ZRA',injury_status='Out',years_exp=0,career_regular_season_games=0,nba_draft_number=1 WHERE id IN(SELECT player_id FROM ra_players);
INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,is_on_taxi,acquired_via,taxi_start_season_year)
SELECT md5('ra-roster-'||m||'-'||p)::uuid,f.league_id,f.season_id,f.member_ids[m],players.player_id,p=5,p=6,'draft',CASE WHEN p=6 THEN 9881 END
FROM ra_fixture f CROSS JOIN generate_series(1,3) m CROSS JOIN generate_series(1,6) p JOIN ra_players players ON players.manager=m AND players.ordinal=p;
UPDATE public.waiver_claims SET process_date=current_date+100 WHERE status='pending';
SET LOCAL session_replication_role=origin;
INSERT INTO public.weekly_add_counts(league_id,league_season_id,member_id,week_number,add_count)
SELECT league_id,season_id,unnest(member_ids),1,0 FROM ra_fixture;
INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
SELECT league_id,season_id,unnest(member_ids),100 FROM ra_fixture ON CONFLICT DO NOTHING;
CREATE FUNCTION pg_temp.worker() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE rows int; empty int:=0; total int:=0; successes int;
BEGIN
  LOOP
    SELECT count(*),count(*) FILTER(WHERE processed) INTO rows,successes FROM public.process_due_waiver_claims_atomic(current_date+1,100);
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    total:=total+successes;
    IF rows=0 THEN empty:=empty+1; ELSE empty:=0; END IF;
    EXIT WHEN empty=2;
  END LOOP;
  IF public.count_due_waiver_claims(current_date+1)>0 THEN RAISE EXCEPTION 'Unprocessed due waiver claims remain after retries.'; END IF;
  PERFORM public.expire_waiver_wire_logs();
  RETURN jsonb_build_object('ok',true,'processed',total);
END;
$$;
CREATE FUNCTION pg_temp.ra_action(command text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE result text;
BEGIN
  EXECUTE command INTO result;
  RETURN coalesce(result,'');
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE||':'||SQLERRM;
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
