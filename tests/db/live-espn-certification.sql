BEGIN;
DO $$
DECLARE
  g uuid := gen_random_uuid(); real_player uuid := gen_random_uuid(); espn_player uuid := gen_random_uuid();
  provider text; live_stats jsonb; final_stats jsonb; t timestamptz := clock_timestamp()-interval '1 minute';
BEGIN
  provider := '002-synthetic-espn-final-'||g;
  INSERT INTO public.players(id,first_name,last_name) VALUES(real_player,'Synthetic',real_player::text),(espn_player,'Synthetic',espn_player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(g,provider,3994,1,'3994-01-01','XXA','XXB','InProgress');
  final_stats := jsonb_build_array(jsonb_build_object('player_id',real_player,'game_id',g,'points',12,'did_not_play',false));
  live_stats := final_stats||jsonb_build_array(jsonb_build_object('player_id',espn_player,'game_id',g,'points',7,'did_not_play',false));
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,jsonb_build_object('source','espn','source_updated_at',t,'elapsed_seconds',2800,
    'status','InProgress','home_score',19,'away_score',0,'status_text','Q4','stats',live_stats));
  PERFORM public.save_final_game_snapshot_atomic(g,provider,final_stats,t-interval '1 minute',12,0,'Final');
  IF (SELECT count(*) FROM public.player_game_stats WHERE game_id=g)<>1
    OR EXISTS(SELECT 1 FROM public.player_game_stats WHERE game_id=g AND player_id=espn_player)
    OR NOT EXISTS(SELECT 1 FROM private.game_stat_revisions WHERE game_id=g) THEN RAISE EXCEPTION 'ESPN-only live rows blocked or contaminated official NBA certification'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sync_runs WHERE function_name='sync-stats:espn-live-reconcile' AND details->>'game_id'=g::text AND jsonb_array_length(details->'removed_provisional_rows')=2) THEN RAISE EXCEPTION 'The NBA reconciliation lost its provisional source audit'; END IF;
  PERFORM public.save_final_game_snapshot_atomic(g,provider,jsonb_set(final_stats,'{0,points}','13'),t,13,0,'Final');
  IF (SELECT points FROM public.player_game_stats WHERE game_id=g)<>13 THEN RAISE EXCEPTION 'NBA corrections failed after ESPN certification cleanup'; END IF;
END;
$$;
ROLLBACK;
SELECT 'ESPN-only live rows do not block NBA final certification or corrections: PASS';
BEGIN;
DO $$
DECLARE
  g uuid := gen_random_uuid(); real_player uuid := gen_random_uuid(); nba_player uuid := gen_random_uuid(); espn_player uuid := gen_random_uuid();
  provider text; nba_stats jsonb; live_stats jsonb; t timestamptz := clock_timestamp()-interval '1 minute'; sample jsonb;
BEGIN
  provider := '002-synthetic-protected-final-'||g;
  INSERT INTO public.players(id,first_name,last_name) VALUES(real_player,'Synthetic',real_player::text),(nba_player,'Synthetic',nba_player::text),(espn_player,'Synthetic',espn_player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(g,provider,3994,1,'3994-01-02','XXC','XXD','InProgress');
  nba_stats := jsonb_build_array(jsonb_build_object('player_id',real_player,'game_id',g,'points',12,'did_not_play',false),jsonb_build_object('player_id',nba_player,'game_id',g,'points',20,'did_not_play',false));
  sample := jsonb_build_object('source','nba','source_updated_at',t-interval '2 seconds','elapsed_seconds',2800,'status','InProgress','home_score',32,'away_score',0,'status_text','Q4','stats',nba_stats);
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample);
  live_stats := nba_stats||jsonb_build_array(jsonb_build_object('player_id',espn_player,'game_id',g,'points',7,'did_not_play',false));
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','source_updated_at',t,'home_score',39,'stats',live_stats));
  BEGIN
    PERFORM public.save_final_game_snapshot_atomic(g,provider,jsonb_build_array(nba_stats->0),t-interval '1 minute',12,0,'Final');
    RAISE EXCEPTION 'An incomplete NBA final bypassed the stored NBA player guard';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF (SELECT status FROM public.nba_games WHERE id=g)<>'InProgress'
    OR NOT EXISTS(SELECT 1 FROM public.player_game_stats WHERE game_id=g AND player_id=espn_player AND points=7) THEN RAISE EXCEPTION 'Failed certification leaked provisional cleanup outside its transaction'; END IF;
  PERFORM public.save_final_game_snapshot_atomic(g,provider,nba_stats,t-interval '1 minute',32,0,'Final');
  IF (SELECT count(*) FROM public.player_game_stats WHERE game_id=g)<>2 THEN RAISE EXCEPTION 'The complete NBA final did not replace ESPN-only rows'; END IF;
END;
$$;
ROLLBACK;
SELECT 'NBA witnessed players remain protected and failed certification rolls back ESPN cleanup: PASS';
BEGIN;
DO $$
DECLARE
  g uuid := gen_random_uuid(); player uuid := gen_random_uuid(); provider text; stats jsonb;
BEGIN
  provider := '002-synthetic-witness-receipt-'||g;
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Synthetic',player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(g,provider,3994,1,'3994-01-03','XXE','XXF','InProgress');
  stats := jsonb_build_array(jsonb_build_object('player_id',player,'game_id',g,'points',12,'did_not_play',false));
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,jsonb_build_object('source','espn','source_updated_at',clock_timestamp()-interval '1 minute',
    'elapsed_seconds',2800,'status','InProgress','home_score',12,'away_score',0,'status_text','Q4','stats',stats,'nba_witness_player_ids',jsonb_build_array(player)));
  IF NOT EXISTS(SELECT 1 FROM private.live_feed_state WHERE game_id=g AND player=ANY(nba_player_ids) AND cardinality(espn_only_player_ids)=0)
    THEN RAISE EXCEPTION 'The NBA witness receipt was lost while ESPN supplied live stats'; END IF;
END;
$$;
ROLLBACK;
SELECT 'An unselected NBA box still protects its witnessed players: PASS';
