BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; claim jsonb; result jsonb; current_trade uuid; pending_id uuid; accepted_id uuid;
  inputs jsonb; publication jsonb; fingerprint text; state public.trade_status; version bigint; queued_before integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9594);
  PERFORM private.begin_trade_lifecycle_write();
  UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL;
  FOREACH state IN ARRAY enum_range(NULL::public.trade_status) LOOP
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
      VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],state) RETURNING id INTO current_trade;
    INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
      VALUES(current_trade,f.league_id,f.member_ids[1],now(),0,true),(current_trade,f.league_id,f.member_ids[2],now(),1,false);
    INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,faab_amount,side)
      VALUES(f.league_id,current_trade,f.member_ids[1],f.member_ids[2],1,'proposer');
    IF state='pending' THEN pending_id:=current_trade;
    ELSIF state='accepted' THEN accepted_id:=current_trade;
    ELSE
      INSERT INTO public.trade_value_cache(trade_id,league_id,league_season_id,revaluation,valid_until,version)
        VALUES(current_trade,f.league_id,f.season_id,'{"frozen":true}','2020-01-01',1);
      PERFORM pg_temp.check_rules(public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],current_trade)->>'closed'='true',
        state::text||' never loads live inputs');
    END IF;
  END LOOP;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  claim:=public.view_refresh_work()->0;
  PERFORM pg_temp.check_rules(NOT claim ? 'trades','screen claims contain no trade valuation work');
  result:=public.view_refresh_work(f.league_id,NULL,jsonb_build_object('operation','complete','seasonId',f.season_id,
    'version',claim->'version','claimToken',claim->'claimToken'));
  PERFORM pg_temp.check_rules(result='true','screens publish without trade valuations');
  version:=(claim->>'version')::bigint;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan'
    AND payload->>'seasonId'=f.season_id::text),'screens do not schedule trade analysis');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,version,'fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id AND key LIKE '%:latest'),
    'only pending and accepted trades get valuation work');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,version,'fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id AND key LIKE '%:latest'),
    'duplicate screen scans reuse valuation work');
  FOREACH current_trade IN ARRAY ARRAY[pending_id,accepted_id] LOOP
    inputs:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],current_trade);
    PERFORM private.refresh_queue_trade_revaluation(current_trade,inputs->>'inputVersion','fixture');
    publication:=jsonb_build_object('tradeId',current_trade,'revaluation',
      jsonb_build_object('inputVersion',inputs->>'inputVersion','modelVersion','fixture','analysis','{}'::jsonb));
    PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,version,jsonb_build_array(publication)),
      CASE WHEN current_trade=pending_id THEN 'pending' ELSE 'accepted' END||' can publish changed inputs');
  END LOOP;
  UPDATE private.screen_refresh_queue AS queued SET version=queued.version+1 WHERE league_season_id=f.season_id;
  version:=version+1;
  SELECT count(*) INTO queued_before FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id;
  PERFORM private.refresh_queue_trade_revaluation(pending_id,public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],pending_id)->>'inputVersion','fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=queued_before FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id),
    'unchanged open inputs skip revaluation after a screen version changes');
  PERFORM pg_temp.check_rules((SELECT published.version=queued.version FROM private.trade_value_publications published
    JOIN private.screen_refresh_queue queued ON queued.league_season_id=f.season_id WHERE published.trade_id=pending_id),
    'unchanged values advance their screen freshness marker');
  inputs:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],pending_id);
  fingerprint:=inputs->>'inputVersion';
  PERFORM pg_temp.check_rules(inputs ? 'cachedRevaluation' AND inputs->'cachedRevaluation'<>'null','unchanged manual reads use the publication');
  UPDATE public.trade_items SET faab_amount=2 WHERE trade_id=pending_id;
  PERFORM pg_temp.check_rules(public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],pending_id)->>'inputVersion'<>fingerprint,
    'changed assets change the fingerprint');
  publication:=jsonb_build_object('tradeId',pending_id,'revaluation',jsonb_build_object('inputVersion',fingerprint,'modelVersion','fixture'));
  PERFORM pg_temp.check_rules(NOT private.refresh_trade_values(f.league_id,f.season_id,version,jsonb_build_array(publication)),
    'an old fingerprint cannot overwrite current inputs');
  PERFORM private.refresh_queue_trade_revaluation(pending_id,public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],pending_id)->>'inputVersion','fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=queued_before FROM private.work_items WHERE kind='trade-revaluation' AND league_id=f.league_id),
    'the changed trade reuses its coalesced work item');
  inputs:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],pending_id);
  publication:=jsonb_build_object('tradeId',pending_id,'revaluation',jsonb_build_object('inputVersion',inputs->>'inputVersion','modelVersion','fixture'));
  UPDATE private.work_items SET status='succeeded',completed_at=now()
    WHERE kind='trade-revaluation' AND payload->>'tradeId'=pending_id::text;
  PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,version,jsonb_build_array(publication)),
    'changed inputs replace the prior publication');
  UPDATE public.trade_items SET faab_amount=1 WHERE trade_id=pending_id;
  PERFORM pg_temp.check_rules(private.refresh_queue_trade_revaluation(pending_id,fingerprint,'fixture'),
    'returning inputs can reuse completed work for the same fingerprint');
  result:=jsonb_build_object('tradeId',pending_id,'revaluation',jsonb_build_object('inputVersion',fingerprint,'modelVersion','fixture'));
  PERFORM pg_temp.check_rules(private.refresh_trade_values(f.league_id,f.season_id,version,jsonb_build_array(result)),
    'a returning fingerprint restores its matching valuation');
  UPDATE public.trades SET status='completed' WHERE id=pending_id;
  PERFORM pg_temp.check_rules(NOT private.refresh_trade_values(f.league_id,f.season_id,version,jsonb_build_array(publication)),
    'a trade closed during work cannot publish');
  PERFORM pg_temp.check_rules((SELECT revaluation->>'inputVersion'=fingerprint FROM public.trade_value_cache WHERE trade_id=pending_id),
    'closing preserves the last published value');
  PERFORM pg_temp.check_rules((SELECT count(*)=7 FROM public.trade_value_cache WHERE league_season_id=f.season_id AND revaluation='{"frozen":true}'),
    'all originally closed publications remain frozen');
END;
$$;
DO $$
DECLARE f record; asset uuid:=gen_random_uuid(); replacement uuid:=gen_random_uuid(); pick uuid:=gen_random_uuid();
  trade uuid; game uuid:=gen_random_uuid(); before text; after text; version bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9596);
  INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(asset,'Fingerprint','Asset','AAA'),(replacement,'Fingerprint','Replacement','BBB');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9596,1,current_date-1,current_date+5);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002-fingerprint',9596,1,current_date,'AAA','BBB','Final');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(asset,game,9596,1,10,20),(replacement,game,9596,1,20,20);
  SELECT q.version INTO version FROM private.screen_refresh_queue q WHERE league_season_id=f.season_id;
  PERFORM private.refresh_player_averages(f.league_id,f.season_id,version);
  INSERT INTO public.draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(pick,f.league_id,9597,1,f.member_ids[2],f.member_ids[2]);
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade;
  INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
    VALUES(trade,f.league_id,f.member_ids[1],now(),0,true),(trade,f.league_id,f.member_ids[2],now(),1,false);
  INSERT INTO public.trade_items(trade_id,side,player_id,pick_id,from_member_id,to_member_id)
    VALUES(trade,'proposer',asset,NULL,f.member_ids[1],f.member_ids[2]),(trade,'recipient',NULL,pick,f.member_ids[2],f.member_ids[1]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules(private.trade_value_player_inputs(f.league_id,f.member_ids[1],9596,ARRAY[asset],1)=
    (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.player_id) FROM public.get_dynasty_forecast_inputs(f.league_id,f.member_ids[1],9596,ARRAY[asset],'',1,0) row),
    'bounded trade player inputs preserve the existing forecast values');
  before:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  INSERT INTO public.dynasty_rankings(source,source_rank,source_player_name,source_player_id,player_id,trade_value,fetched_at)
    VALUES('onenumberhoops.com',98989,'Fingerprint Asset',asset::text,asset,750,now());
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before<>after,'asset market values change the fingerprint');
  before:=after;
  INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points) VALUES(asset,9596,1,25);
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before<>after,'asset projections change the fingerprint');
  before:=after;
  UPDATE public.draft_picks SET predicted_trade_value=623.4,predicted_value_bands='{"early":750,"mid":500,"late":350}' WHERE id=pick;
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before<>after,'pick predictions change the fingerprint');
  before:=after;
  UPDATE public.draft_picks SET prediction_version='fingerprint-v2' WHERE id=pick;
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before<>after,'pick prediction versions change the fingerprint');
  before:=after;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],replacement,'draft');
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before<>after,'the replacement roster context changes the fingerprint');
  before:=after;
  UPDATE public.league_members SET team_name='Renamed' WHERE id=f.member_ids[1];
  after:=public.get_trade_revaluation_inputs(f.user_ids[1],f.member_ids[1],trade)->>'inputVersion';
  PERFORM pg_temp.check_rules(before=after,'an unrelated team name leaves valuation inputs unchanged');
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
