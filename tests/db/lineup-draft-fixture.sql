SET LOCAL statement_timeout='120s';
\ir rules-support.sql
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
SELECT year,n,(now() AT TIME ZONE 'America/New_York')::date+(n-1)*7,(now() AT TIME ZONE 'America/New_York')::date+n*7-1 FROM generate_series(9581,9583)year CROSS JOIN generate_series(1,30)n;
CREATE TEMP TABLE action_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9583);
UPDATE public.leagues SET roster_size=20,playoff_entrants=2,playoff_round_lengths=ARRAY[1] WHERE id=(SELECT league_id FROM action_fixture);
DELETE FROM public.lineup_slot_templates WHERE league_id=(SELECT league_id FROM action_fixture);
INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count)
SELECT league_id,'UTIL',8 FROM action_fixture;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time) VALUES('action-earlier-game',9583,1,(now() AT TIME ZONE 'America/New_York')::date,'AC1','AC2','InProgress',now()-interval '1 hour');
CREATE TEMP TABLE action_players AS
SELECT player_id AS id,row_number() OVER(ORDER BY count(*) DESC,player_id)::int AS n
FROM public.player_game_stats GROUP BY player_id ORDER BY count(*) DESC,player_id LIMIT 60;
UPDATE public.players SET nba_team='ACL',injury_status=NULL WHERE id IN(SELECT id FROM action_players);
INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points)
SELECT id,9583,week,n%17 FROM action_players CROSS JOIN generate_series(1,2)week;
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT f.league_id,f.season_id,f.member_ids[(p.n-1)/20+1],p.id,'draft' FROM action_fixture f CROSS JOIN action_players p;
INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
SELECT f.league_id,f.season_id,f.member_ids[(p.n-1)/20+1],p.id,1,day,'UTIL',true
FROM action_fixture f CROSS JOIN action_players p CROSS JOIN generate_series(
(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+1,interval '1 day')day
WHERE (p.n-1)%20<8;
INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
SELECT f.league_id,f.season_id,m,true FROM action_fixture f CROSS JOIN unnest(f.member_ids)m
ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
CREATE TEMP TABLE action_tipoff AS SELECT now()+interval '30 seconds' AS at,gen_random_uuid() AS token;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
SELECT 'action-future-'||offset_day,9583,CASE WHEN offset_day=8 THEN 2 ELSE 1 END,(now() AT TIME ZONE 'America/New_York')::date+offset_day,'AC3','AC4','Scheduled',now()+offset_day*interval '1 day'+interval '30 seconds' FROM unnest(ARRAY[0,1,8])offset_day;
INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
SELECT at,(now() AT TIME ZONE 'America/New_York')::date,'running',token,now()+interval '2 minutes' FROM action_tipoff;
CREATE TEMP TABLE action_rookies AS SELECT * FROM pg_temp.rules_fixture(3,9582,'offseason');
INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
SELECT f.league_id,9582,r,m,m FROM action_rookies f CROSS JOIN unnest(f.member_ids)m CROSS JOIN generate_series(1,3)r;
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM action_rookies),true);
UPDATE public.leagues SET playoff_entrants=2,playoff_round_lengths=ARRAY[1] WHERE id=(SELECT league_id FROM action_rookies);
CREATE TEMP TABLE action_snake AS SELECT (public.start_rookie_draft_atomic(league_id,3,false,300)->>'id')::uuid AS id FROM action_rookies;
CREATE TEMP TABLE action_auction_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9581,'setup');
UPDATE public.leagues SET auction_budget=200 WHERE id=(SELECT league_id FROM action_auction_fixture);
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM action_auction_fixture),true);
UPDATE public.leagues SET playoff_entrants=2,playoff_round_lengths=ARRAY[1] WHERE id=(SELECT league_id FROM action_auction_fixture);
CREATE TEMP TABLE action_auction AS SELECT (public.start_auction_draft_atomic(league_id)).id FROM action_auction_fixture;
CREATE TEMP TABLE action_cases(name text,manager int,prepare text,command text);
DO $$
DECLARE f record; d record; a record; i int; today date := (now() AT TIME ZONE 'America/New_York')::date;
  player uuid; bench uuid; rookie uuid; nomination uuid:=gen_random_uuid(); payload jsonb; same_payload jsonb;
  auth text; dauth text; aauth text; advance text;
BEGIN
SELECT * INTO f FROM action_fixture;
SELECT * INTO d FROM action_rookies;
SELECT * INTO a FROM action_auction_fixture;
SELECT id INTO rookie FROM public.players WHERE years_exp=0 AND nba_draft_number IS NOT NULL ORDER BY nba_draft_number,id LIMIT 1;
FOR i IN 1..3 LOOP
SELECT id INTO player FROM action_players WHERE n=(i-1)*20+1;
SELECT id INTO bench FROM action_players WHERE n=(i-1)*20+9;
SELECT jsonb_agg(jsonb_build_object('player_id',wl.player_id,'slot_type',wl.slot_type,'week_number',1,'is_auto_set',true,'expected_active',false) ORDER BY wl.player_id)
INTO same_payload FROM public.weekly_lineups wl WHERE member_id=f.member_ids[i] AND game_date=today;
payload:=same_payload-0;
auth:=format('SELECT set_config(''request.jwt.claim.sub'',%L,true);',f.user_ids[i]);
dauth:=format('SELECT set_config(''request.jwt.claim.sub'',%L,true); UPDATE public.snake_draft_picks SET member_id=%L WHERE draft_id=%L AND overall_pick=1; UPDATE public.draft_picks SET current_owner_id=%L WHERE id=(SELECT draft_pick_id FROM public.snake_draft_picks WHERE draft_id=%L AND overall_pick=1);',d.user_ids[i],d.member_ids[i],(SELECT id FROM action_snake),d.member_ids[i],(SELECT id FROM action_snake));
aauth:=format('SELECT set_config(''request.jwt.claim.sub'',%L,true); UPDATE public.drafts SET current_nomination_order=(SELECT position FROM public.draft_orders WHERE draft_id=%L AND member_id=%L) WHERE id=%L;',a.user_ids[i],(SELECT id FROM action_auction),a.member_ids[i],(SELECT id FROM action_auction));
INSERT INTO action_cases VALUES
('slot-move',i,auth,format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','BE'),jsonb_build_object('player_id',bench,'slot_type','UTIL')))),
('slot-repeat',i,auth,format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','UTIL')))),
('auto-set-full',i,auth,format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,same_payload)),
('auto-set-fill',i,auth,format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,payload)),
('optimizer-write',i,auth,format('SELECT public.auto_set_lineup_service_atomic(%L,%L,%L,%L,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,payload)),
('optimizer-context',i,auth,format('SELECT public.get_pre_tipoff_lineup_context(%L,%L,%L);',f.league_id,f.season_id,f.member_ids[i])),
('pre-tipoff-same',i,auth,format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L::jsonb);',(SELECT at FROM action_tipoff),(SELECT token FROM action_tipoff),f.league_id,f.season_id,f.member_ids[i],same_payload)),
('pre-tipoff-change',i,auth,format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L::jsonb);',(SELECT at FROM action_tipoff),(SELECT token FROM action_tipoff),f.league_id,f.season_id,f.member_ids[i],payload)),
('rookie-pick',i,dauth,format('SELECT public.make_snake_pick_atomic(%L,%L,%L);',(SELECT id FROM action_snake),d.member_ids[i],rookie)),
('autopick',i,dauth,format('SELECT public.auto_pick_snake_pick_atomic(%L,%L,''manual'');',(SELECT id FROM action_snake),d.member_ids[i])),
('timer-idle',i,dauth,format('SELECT * FROM public.process_expired_snake_pick_atomic(%L);',(SELECT id FROM action_snake))),
('timer-expired',i,dauth||format('UPDATE public.snake_draft_picks SET timer_expires_at=now()-interval ''1 second'' WHERE draft_id=%L AND overall_pick=1;',(SELECT id FROM action_snake)),format('SELECT * FROM public.process_expired_snake_pick_atomic(%L);',(SELECT id FROM action_snake))),
('nominate',i,aauth,format('SELECT public.create_auction_nomination_atomic(%L,%L,%L,%L);',(SELECT id FROM action_auction),a.member_ids[i],rookie,a.user_ids[i]));
advance:=aauth||format('INSERT INTO public.nominations(id,draft_id,nominating_member_id,player_id,nomination_order,status,current_bid_amount,current_bidder_id,countdown_expires_at) VALUES(%L,%L,%L,%L,1,''open'',0,NULL,now()+interval ''1 minute'');',nomination,(SELECT id FROM action_auction),a.member_ids[i],rookie);
INSERT INTO action_cases VALUES
('bid',i,advance,format('SELECT public.place_auction_bid_atomic(%L,%L,%L,1,%L);',(SELECT id FROM action_auction),a.member_ids[i],nomination,a.user_ids[i])),
('close-expired',i,advance||format('UPDATE public.nominations SET countdown_expires_at=now()-interval ''1 second'' WHERE id=%L;',nomination),'SELECT * FROM public.close_expired_auction_nominations_atomic(100);'),
('close-snake-expired',i,dauth||format('UPDATE public.snake_draft_picks SET timer_expires_at=now()-interval ''1 second'' WHERE draft_id=%L AND overall_pick=1;',(SELECT id FROM action_snake)),'SELECT * FROM public.process_expired_snake_picks_atomic(100);');
INSERT INTO action_cases VALUES
('denied-slot-owner',i,auth||format('SELECT set_config(''request.jwt.claim.sub'',%L,true);',f.user_ids[i%3+1]),format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','BE')))),
('denied-slot-ir',i,auth,format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','IR')))),
('denied-slot-past',i,auth,format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,''[]''::jsonb);',f.member_ids[i],f.league_id,f.season_id,today-1)),
('denied-slot-locked',i,auth||format('INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time) VALUES(%L,9583,1,%L,''ACL'',''ACK'',''InProgress'',now()-interval ''1 minute'');','action-lock-'||i,today+1),format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','BE')))),
('auto-set-empty',i,auth,format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,''[]''::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+1)),
('auto-set-future',i,auth,format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,''[]''::jsonb);',f.member_ids[i],f.league_id,f.season_id,today+8)),
('denied-tipoff-schedule',i,auth,format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L::jsonb);',(SELECT at FROM action_tipoff),(SELECT token FROM action_tipoff),f.league_id,f.season_id,f.member_ids[i],jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','UTIL','expected_active',true)))),
('denied-tipoff-injury',i,auth||format('UPDATE public.players SET injury_status=''Out'' WHERE id=%L;',player),format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L::jsonb);',(SELECT at FROM action_tipoff),(SELECT token FROM action_tipoff),f.league_id,f.season_id,f.member_ids[i],jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','UTIL','expected_active',true))));
END LOOP;
INSERT INTO action_cases SELECT 'sync-draft-order',1,'',format('SELECT public.resolve_player_imports_atomic(''nba_draft'',%L::jsonb);',jsonb_agg(jsonb_build_object('display_name',display_name,'nba_draft_number',nba_draft_number) ORDER BY nba_draft_number)) FROM public.players WHERE years_exp=0 AND nba_draft_number IS NOT NULL;
INSERT INTO action_cases SELECT 'timer-'||behavior,c.manager,c.prepare||format('UPDATE public.drafts SET timer_expiry_behavior=%L WHERE id=%L;',behavior,(SELECT id FROM action_snake)),c.command FROM action_cases c CROSS JOIN unnest(ARRAY['skip_pick','pause_draft','commissioner_pick'])behavior WHERE c.name='timer-expired';
INSERT INTO action_cases SELECT 'auto-set-today',manager,prepare,replace(command,((now() AT TIME ZONE 'America/New_York')::date+1)::text,((now() AT TIME ZONE 'America/New_York')::date)::text) FROM action_cases WHERE name='auto-set-full';
INSERT INTO action_cases SELECT 'slot-move-today',manager,prepare,replace(command,((now() AT TIME ZONE 'America/New_York')::date+1)::text,((now() AT TIME ZONE 'America/New_York')::date)::text) FROM action_cases WHERE name='slot-move';
INSERT INTO action_cases SELECT 'mock-snake-pick',c.manager,c.prepare||format('UPDATE public.drafts SET is_mock=true WHERE id=%L;',(SELECT id FROM action_snake)),c.command FROM action_cases c WHERE c.name='rookie-pick';
END;
$$;
INSERT INTO action_cases VALUES('instrumentation-control',1,'','SELECT NULL;');
