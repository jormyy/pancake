-- Stale compound activation must not free another roster slot.
BEGIN;
SELECT gen_random_uuid() AS owner_id, gen_random_uuid() AS league_id, gen_random_uuid() AS season_id,
 gen_random_uuid() AS member_id, gen_random_uuid() AS target_id, gen_random_uuid() AS free_id,
 gen_random_uuid() AS target_player_id, gen_random_uuid() AS free_player_id \gset
INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES (:'owner_id','authenticated','authenticated',:'owner_id'||'@example.test','x',now(),'{}','{}',now(),now());
INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
VALUES (:'league_id','Compound activation source',:'league_id',:'owner_id','active',2,2,2);
INSERT INTO league_members(id,league_id,user_id,role,team_name)
VALUES (:'member_id',:'league_id',:'owner_id','commissioner','Activation owner');
INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES (:'season_id',:'league_id',2165,true);
INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,nba_draft_number)
VALUES (:'target_player_id','Synthetic',:'target_player_id',NULL,'PG',ARRAY['PG'],'Out',0,1),
 (:'free_player_id','Synthetic',:'free_player_id',NULL,'PG',ARRAY['PG'],'Out',2,NULL);
INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via)
VALUES (:'target_id',:'league_id',:'season_id',:'member_id',:'target_player_id',false,'draft'),
 (:'free_id',:'league_id',:'season_id',:'member_id',:'free_player_id',false,'draft');
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
CREATE FUNCTION pg_temp.activation_state(l uuid) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object(
 'rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM roster_players r WHERE league_id=l),
 'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM roster_transactions t WHERE league_id=l),
 'waivers',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM waiver_wire_log w WHERE league_id=l),
 'lineups',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM weekly_lineups d WHERE league_id=l))
$$;
CREATE TEMP TABLE expected_activation AS SELECT pg_temp.activation_state(:'league_id') AS state;
CREATE FUNCTION pg_temp.reject_activation(q text, message_pattern text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean := false;
BEGIN
 BEGIN EXECUTE q;
 EXCEPTION WHEN SQLSTATE 'P0001' OR SQLSTATE 'P0002' OR SQLSTATE '42501' THEN
  IF SQLERRM NOT LIKE message_pattern THEN RAISE; END IF;
  rejected := true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Stale activation unexpectedly succeeded: %',q; END IF;
END;
$$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',
 :'target_id',source,:'free_id',action),'%no longer on%')
FROM unnest(ARRAY['ir','taxi']) source CROSS JOIN unnest(ARRAY['drop','ir']) action;
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_lineup_atomic(%L,%L,%L,%L,%L,%L,%L,current_date,1,%L)',
 :'target_id',source,:'free_id','drop',:'member_id',:'league_id',:'season_id',slot),'%no longer on%')
FROM unnest(ARRAY['ir','taxi']) source CROSS JOIN unnest(ARRAY[NULL,'BE','PG']) slot;
RESET ROLE;
SELECT set_config('activation.league_id',:'league_id',true);
DO $$ BEGIN
 IF (SELECT state FROM expected_activation) IS DISTINCT FROM pg_temp.activation_state(current_setting('activation.league_id')::uuid)
 THEN RAISE EXCEPTION 'Rejected activation changed roster, waivers, transactions or lineups'; END IF;
END $$;
-- Legal IR overflow still succeeds, including an IR exchange below active capacity.
UPDATE roster_players SET is_on_ir=true WHERE id=:'target_id';
SET LOCAL ROLE authenticated;
SELECT public.activate_roster_player_with_overflow_atomic(:'target_id','ir',:'free_id','ir');
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM roster_players WHERE league_id=current_setting('activation.league_id')::uuid AND is_on_ir)=1
 AND (SELECT count(*) FROM roster_transactions WHERE league_id=current_setting('activation.league_id')::uuid)=2 THEN NULL;
 ELSE RAISE EXCEPTION 'Legal IR exchange failed'; END IF;
END $$;
-- Return target to IR through the actual designation, then test supplied lineup ownership even for BE.
SET LOCAL ROLE service_role;
SELECT public.toggle_ir_atomic(:'target_id',true,:'owner_id');
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_lineup_atomic(%L,%L,NULL,NULL,%L,%L,%L,current_date,1,%L)',
 :'target_id','ir',gen_random_uuid(),:'league_id',:'season_id','BE'),'%not on this roster%');
SELECT public.activate_roster_player_with_lineup_atomic(:'target_id','ir',NULL,NULL,:'member_id',:'league_id',:'season_id',current_date,1,'BE');
RESET ROLE;
-- Wrong caller and missing freed row fail before any mutation.
SELECT set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',
 :'target_id','ir',:'free_id','drop'),'%Not authorized%');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',:'owner_id',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',
 :'target_id','ir',gen_random_uuid(),'drop'),'%same roster%');
RESET ROLE;
-- A fresh eligible taxi acquisition is setup, then actual activation and a replay rejection.
SELECT private.authorize_taxi_acquisition(:'league_id',:'season_id',:'member_id',:'target_player_id','draft',:'target_id');
UPDATE roster_players SET is_on_taxi=true WHERE id=:'target_id';
SET LOCAL ROLE authenticated;
SELECT public.activate_roster_player_with_lineup_atomic(:'target_id','taxi',NULL,NULL,:'member_id',:'league_id',:'season_id',current_date,1,'BE');
SELECT pg_temp.reject_activation(format(
 'SELECT public.activate_roster_player_with_overflow_atomic(%L,%L,%L,%L)',
 :'target_id','taxi',:'free_id','drop'),'%no longer on%');
RESET ROLE;
DO $$ BEGIN
 IF has_function_privilege('authenticated','private.lock_roster_activation(uuid,text,uuid)','EXECUTE')
 OR has_function_privilege('anon','private.lock_roster_activation(uuid,text,uuid)','EXECUTE')
 OR has_function_privilege('service_role','private.lock_roster_activation(uuid,text,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'Private activation lock helper is client executable'; END IF;
END $$;
ROLLBACK;
