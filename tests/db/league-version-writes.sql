\set ON_ERROR_STOP on
\getenv version_db_port PANCAKE_TEST_DB_PORT
\if :{?version_db_port}
\else
  \set version_db_port 59122
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'version_db_port' AS version_local \gset
\if :version_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private loopback version test database.'; END $$;
\endif
SET statement_timeout='60s';
SET lock_timeout='5s';
SET app.supabase_url='http://127.0.0.1:1';
SET app.edge_internal_token='local-version-probe';
BEGIN;
DELETE FROM public.draft_orders WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.draft_budgets WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.snake_draft_picks WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.bids WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.nominations WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.drafts WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.leagues WHERE id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.player_game_stats WHERE season_year=9562;
DELETE FROM public.player_projections WHERE season_year=9562;
DELETE FROM public.players WHERE first_name='Version';
DELETE FROM public.nba_games WHERE season_year=9562;
DELETE FROM public.season_weeks WHERE season_year=9562;
\ir rules-support.sql
CREATE TEMP TABLE version_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9562);
ALTER TABLE version_fixture ADD COLUMN players uuid[];
ALTER TABLE version_fixture ADD COLUMN matchup_id uuid DEFAULT gen_random_uuid();
ALTER TABLE version_fixture ADD COLUMN game_id uuid DEFAULT gen_random_uuid();
ALTER TABLE version_fixture ADD COLUMN draft_id uuid;
ALTER TABLE version_fixture ADD COLUMN trade_id uuid;
ALTER TABLE version_fixture ADD COLUMN claim_id uuid;
DO $$
DECLARE f record; ids uuid[];
BEGIN
  INSERT INTO public.players(first_name,last_name,position,eligible_positions,status,nba_team,injury_status,years_exp,nba_draft_number)
    SELECT 'Version',gen_random_uuid()::text,'PG',ARRAY['PG'],'Active','BOS','Out',0,n FROM generate_series(1,12)n;
  SELECT array_agg(id ORDER BY nba_draft_number) INTO ids FROM public.players WHERE first_name='Version';
  UPDATE version_fixture SET players=ids;
  SELECT * INTO f FROM version_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,false);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9562,1,current_date,current_date+6);
  INSERT INTO public.nba_games(id,season_year,nba_game_id,game_date,week_number,home_team,away_team,status,game_time)
    VALUES(f.game_id,9562,'0029562001',current_date,1,'BOS','NYK','Scheduled',now()+interval '8 hours');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(f.matchup_id,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',4) ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=4;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],f.players[2],'draft'),(f.league_id,f.season_id,f.member_ids[1],f.players[1],'draft');
END;
$$;
COMMIT;
CREATE TEMP TABLE version_proofs(label text PRIMARY KEY,before_version bigint,after_version bigint);
CREATE PROCEDURE pg_temp.version_write(label text,command text,expected integer DEFAULT 1,rejection text DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE league uuid; before_version bigint; after_version bigint; caught text; publication record;
BEGIN
  SELECT league_id INTO league FROM version_fixture;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=league;
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF rejection IS NULL OR SQLERRM NOT LIKE rejection THEN RAISE; END IF;
    caught:=SQLERRM;
  END;
  IF rejection IS NOT NULL AND caught IS NULL THEN RAISE EXCEPTION 'Expected rejection: %',label; END IF;
  COMMIT;
  FOR publication IN SELECT id FROM private.trade_publications WHERE league_id=league ORDER BY id LOOP
    PERFORM private.publish_trade_changes(publication.id);
    DELETE FROM private.work_items WHERE kind='trade-publication' AND payload->>'publicationId'=publication.id::text;
  END LOOP;
  COMMIT;
  SELECT version INTO after_version FROM public.league_versions WHERE league_id=league;
  IF after_version IS DISTINCT FROM before_version+expected THEN
    RAISE EXCEPTION '%: expected bump %, before %, after %',label,expected,before_version,after_version;
  END IF;
  IF (SELECT count(*) FROM public.league_changes WHERE league_id=league AND version>before_version)<>expected THEN
    RAISE EXCEPTION '%: change log does not match bump',label;
  END IF;
  IF (SELECT revision FROM public.league_change_hints WHERE league_id=league AND topic='version')<>after_version THEN
    RAISE EXCEPTION '%: realtime does not match version',label;
  END IF;
  IF EXISTS(SELECT 1 FROM private.league_version_pending) THEN RAISE EXCEPTION 'Commit leaves pending work'; END IF;
  INSERT INTO version_proofs VALUES(label,before_version,after_version);
END;
$$;
CALL pg_temp.version_write('draft roster write',$cmd$INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) SELECT league_id,season_id,member_ids[1],players[5],'draft' FROM version_fixture$cmd$);
CALL pg_temp.version_write('retired free agent path',$cmd$SELECT public.add_free_agent_atomic(member_ids[1],league_id,players[4]) FROM version_fixture$cmd$,0,'Every pickup requires a scheduled waiver claim.%');
CALL pg_temp.version_write('rejected add',$cmd$SELECT public.add_free_agent_atomic(member_ids[1],league_id,players[1]) FROM version_fixture$cmd$,0,'This player is already on a roster.');
CALL pg_temp.version_write('set_player_slot_atomic',$cmd$SELECT public.set_player_slot_atomic(member_ids[1],league_id,season_id,players[1],current_date,'PG',1) FROM version_fixture$cmd$);
CALL pg_temp.version_write('toggle_ir_atomic',$cmd$SELECT public.toggle_ir_atomic((SELECT id FROM public.roster_players WHERE player_id=f.players[1] AND league_id=f.league_id),true,user_ids[1]) FROM version_fixture f$cmd$);
CALL pg_temp.version_write('activate_roster_player_with_lineup_atomic',$cmd$SELECT public.activate_roster_player_with_lineup_atomic((SELECT id FROM public.roster_players WHERE player_id=f.players[1] AND league_id=f.league_id),'ir',NULL,NULL,member_ids[1],league_id,season_id,current_date,1,'PG') FROM version_fixture f$cmd$);
CALL pg_temp.version_write('settings multi-table',$cmd$SELECT public.update_league_configuration_atomic(league_id,'{"weekly_add_limit":9}') FROM version_fixture$cmd$);
CALL pg_temp.version_write('rejected settings',$cmd$SELECT public.update_league_configuration_atomic(league_id,'{"team_limit":1}') FROM version_fixture$cmd$,0,'Team limit must be at least 2%');
CALL pg_temp.version_write('weekly add override',$cmd$SELECT public.commissioner_override_weekly_add_count_atomic(league_id,member_ids[1],2) FROM version_fixture$cmd$);
CALL pg_temp.version_write('faab setting',$cmd$SELECT public.update_league_settings_atomic(f.league_id,jsonb_build_object('faab_starting_budget',(SELECT faab_starting_budget+1 FROM public.leagues WHERE id=f.league_id))) FROM version_fixture f$cmd$);
CALL pg_temp.version_write('faab adjustment',$cmd$SELECT public.commissioner_adjust_faab_balance_atomic(league_id,member_ids[1],50) FROM version_fixture$cmd$);
CALL pg_temp.version_write('inventory key update',$cmd$UPDATE public.faab_balances SET id=gen_random_uuid() WHERE member_id=(SELECT member_ids[1] FROM version_fixture)$cmd$);
CALL pg_temp.version_write('create pending claim',$cmd$UPDATE version_fixture SET claim_id=public.create_waiver_claim_atomic(league_id,member_ids[1],players[3],NULL,user_ids[1],1)$cmd$);
CALL pg_temp.version_write('edit pending claim',$cmd$SELECT public.edit_waiver_claim_atomic(claim_id,member_ids[1],user_ids[1],NULL,2,NULL) FROM version_fixture$cmd$);
CALL pg_temp.version_write('cancel private claim',$cmd$SELECT public.cancel_waiver_claim_atomic(claim_id,member_ids[1],user_ids[1]) FROM version_fixture$cmd$);
CALL pg_temp.version_write('propose trade',$cmd$UPDATE version_fixture SET trade_id=public.propose_trade_atomic(league_id,season_id,member_ids[1],member_ids[2],ARRAY[players[1]],ARRAY[players[2]],'{}','{}')$cmd$,2);
SET request.jwt.claim.sub='';
CALL pg_temp.version_write('withdraw trade',$cmd$SELECT public.withdraw_trade_atomic(trade_id,member_ids[1],user_ids[1]) FROM version_fixture$cmd$);
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM version_fixture),false);
CALL pg_temp.version_write('trade block',$cmd$SELECT public.add_trade_block_item_atomic(member_ids[1],league_id,players[1],NULL,'version probe') FROM version_fixture$cmd$);
\ir league-version-transaction-writes.sql
BEGIN;
UPDATE public.roster_players roster SET member_id=fixture.member_ids[1],is_on_ir=false,is_on_taxi=false
FROM version_fixture fixture WHERE roster.league_id=fixture.league_id
  AND roster.player_id=ANY(ARRAY[fixture.players[1],fixture.players[5],fixture.players[6],fixture.players[7]]);
COMMIT;
\ir league-version-roster-writes.sql
\ir league-version-player-writes.sql
CALL pg_temp.version_write('live scoreboard worker',$cmd$SELECT public.save_live_scoreboard_atomic(game_id,'0029562001','InProgress',3,2,'Q1',10) FROM version_fixture$cmd$);
CALL pg_temp.version_write('stale scoreboard worker',$cmd$SELECT public.save_live_scoreboard_atomic(game_id,'0029562001','Scheduled',0,0,'Scheduled',0) FROM version_fixture$cmd$,0);
CALL pg_temp.version_write('players worker',$cmd$UPDATE public.players SET injury_status='Questionable' WHERE id=(SELECT players[3] FROM version_fixture)$cmd$);
CALL pg_temp.version_write('optimizer worker',$cmd$UPDATE public.lineup_optimizer_settings SET last_optimized_at=clock_timestamp() WHERE league_id=(SELECT league_id FROM version_fixture)$cmd$);
CALL pg_temp.version_write('score worker',$cmd$UPDATE public.matchups SET home_points=5,away_points=3 WHERE id=(SELECT matchup_id FROM version_fixture)$cmd$);
CALL pg_temp.version_write('forecast worker',$cmd$INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until) SELECT matchup_id,league_id,1,'{}',now(),now()+interval '1 hour' FROM version_fixture$cmd$);
CALL pg_temp.version_write('stats worker',$cmd$INSERT INTO public.player_game_stats(game_id,player_id,season_year,game_date,week_number,points) SELECT game_id,players[1],9562,current_date,1,5 FROM version_fixture$cmd$);
\ir league-version-score-writes.sql
CALL pg_temp.version_write('projections worker',$cmd$INSERT INTO public.player_projections(player_id,season_year,week_number,projected_points) SELECT players[1],9562,1,21 FROM version_fixture$cmd$);
CALL pg_temp.version_write('same values',$cmd$UPDATE public.players SET injury_status=injury_status WHERE id=(SELECT players[3] FROM version_fixture)$cmd$,0);
CALL pg_temp.version_write('multiple writes one commit',$cmd$DO $body$BEGIN UPDATE public.leagues SET name=name||' updated' WHERE id=(SELECT league_id FROM version_fixture); UPDATE public.league_members SET team_name=team_name||' updated' WHERE league_id=(SELECT league_id FROM version_fixture); END$body$;$cmd$);
CALL pg_temp.version_write('rejected after writes',$cmd$DO $body$BEGIN UPDATE public.leagues SET name='must roll back' WHERE id=(SELECT league_id FROM version_fixture); RAISE EXCEPTION 'synthetic rollback'; END$body$;$cmd$,0,'synthetic rollback');
CALL pg_temp.version_write('remove member',$cmd$DO $body$BEGIN DELETE FROM public.trade_vetos WHERE member_id=(SELECT member_ids[3] FROM version_fixture); DELETE FROM public.waiver_priorities WHERE member_id=(SELECT member_ids[3] FROM version_fixture); DELETE FROM public.faab_balances WHERE member_id=(SELECT member_ids[3] FROM version_fixture); DELETE FROM public.league_members WHERE id=(SELECT member_ids[3] FROM version_fixture); END$body$;$cmd$);
CALL pg_temp.version_write('draft setup',$cmd$UPDATE public.leagues SET status='setup' WHERE id=(SELECT league_id FROM version_fixture)$cmd$);
CALL pg_temp.version_write('lineup slot settings',$cmd$SELECT public.update_lineup_slots_atomic(league_id,'[{"slot_type":"PG","slot_count":6}]') FROM version_fixture$cmd$);
CALL pg_temp.version_write('start auction draft',$cmd$UPDATE version_fixture SET draft_id=(public.start_auction_draft_atomic(league_id,'user_nominated',false,30,200)).id$cmd$);
CALL pg_temp.version_write('pause draft',$cmd$SELECT public.pause_draft_atomic(draft_id) FROM version_fixture$cmd$);
CALL pg_temp.version_write('resume draft',$cmd$SELECT public.resume_draft_atomic(draft_id) FROM version_fixture$cmd$);
CALL pg_temp.version_write('stop draft',$cmd$SELECT public.stop_draft_atomic(draft_id) FROM version_fixture$cmd$);
\ir league-version-draft-writes.sql

DO $$
DECLARE f record; response jsonb; before_version bigint;
BEGIN
  SELECT * INTO f FROM version_fixture;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  response:=public.get_league_version(f.league_id,f.user_ids[1],before_version::text);
  PERFORM pg_temp.check_rules(response=jsonb_build_object('version',before_version::text,'changes','[]'::jsonb),'no change response is tiny');
  response:=public.get_league_version(f.league_id,f.user_ids[1],(before_version-1)::text);
  PERFORM pg_temp.check_rules(jsonb_array_length(response->'changes')=1,'since returns one indexed change');
  PERFORM pg_temp.reject_rules(format('SELECT public.get_league_version(%L,%L)',f.league_id,gen_random_uuid()),'League not found','outsider denied');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.get_league_version(uuid,uuid,text)','EXECUTE'),'caller cannot forge user identity');
END;
$$;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM version_fixture;
  PERFORM pg_temp.reject_rules(format('SELECT public.get_league_version(%L,%L)',f.league_id,f.user_ids[3]),'League not found','removed member denied by cached readers');
END;
$$;
SELECT * FROM version_proofs ORDER BY before_version,label;
SELECT count(*) AS committed_write_proofs FROM version_proofs;
BEGIN;
DELETE FROM public.draft_orders WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.draft_budgets WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.snake_draft_picks WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.bids WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.nominations WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.drafts WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.leagues WHERE id=(SELECT league_id FROM version_fixture);
DELETE FROM public.player_game_stats WHERE season_year=9562;
DELETE FROM public.player_projections WHERE season_year=9562;
DELETE FROM public.players WHERE first_name='Version';
DELETE FROM auth.users WHERE id=ANY((SELECT user_ids FROM version_fixture)::uuid[]);
DELETE FROM public.nba_games WHERE season_year=9562;
DELETE FROM public.season_weeks WHERE season_year=9562;
COMMIT;
