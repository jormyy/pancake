\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE player uuid:=gen_random_uuid(); other_player uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); other_game uuid:=gen_random_uuid(); identity uuid:=gen_random_uuid();
  total numeric;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid='public.player_game_stats'::regclass)<>'r' THEN
    RAISE EXCEPTION 'Player stats must be a regular table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.player_game_stats'::regclass AND NOT tgisinternal)<>29
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.player_game_stats'::regclass AND NOT tgisinternal AND (tgoldtable IS NOT NULL OR tgnewtable IS NOT NULL))<>18 THEN
    RAISE EXCEPTION 'Stats triggers or transition tables are lost';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_rewrite r JOIN pg_depend d ON d.objid=r.oid WHERE r.ev_class='public.v_fantasy_points'::regclass AND d.refobjid='public.player_game_stats'::regclass)
    OR NOT EXISTS(SELECT FROM pg_rewrite r JOIN pg_depend d ON d.objid=r.oid WHERE r.ev_class='analytics.mv_player_avg_fantasy_points'::regclass AND d.refobjid='public.player_game_stats'::regclass) THEN
    RAISE EXCEPTION 'A stats view references the retired table';
  END IF;
  IF EXISTS(SELECT FROM pg_class WHERE oid IN ('public.v_fantasy_points'::regclass,'analytics.mv_player_avg_fantasy_points'::regclass) AND NOT coalesce(reloptions @> ARRAY['security_invoker=true'],false)) THEN RAISE EXCEPTION 'A stats view loses invoker security'; END IF;
  IF EXISTS(SELECT FROM pg_inherits WHERE inhparent='public.player_game_stats'::regclass AND
    (has_table_privilege('anon',inhrelid,'SELECT') OR has_table_privilege('authenticated',inhrelid,'SELECT') OR has_table_privilege('service_role',inhrelid,'INSERT'))) THEN
    RAISE EXCEPTION 'A stats child bypasses parent access';
  END IF;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES(player,'Partition','Fixture','PG',ARRAY['PG'],'BOS'),(other_player,'Partition','Stale','PG',ARRAY['PG'],'BOS');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
  VALUES(game,'002stats-partition-a',2097,1,'2096-10-20','2096-10-20 22:00Z','BOS','LAL','InProgress'),
    (other_game,'002stats-partition-b',2098,1,'2097-10-20','2097-10-20 22:00Z','BOS','LAL','InProgress');
  INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number,points) VALUES(identity,player,game,1900,1,11);
  SELECT points INTO total FROM analytics.player_season_totals WHERE player_id=player AND season_year=2097;
  IF total IS DISTINCT FROM 11::numeric THEN RAISE EXCEPTION 'Insert transition totals differ'; END IF;
  IF (SELECT tableoid FROM public.player_game_stats WHERE id=identity)<>'public.player_game_stats'::regclass THEN RAISE EXCEPTION 'A write uses an old partition'; END IF;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play) VALUES(other_player,game,1900,1,0,true);
  IF NOT EXISTS(SELECT FROM public.player_game_stats WHERE player_id=other_player AND season_year=2097 AND game_id=game) THEN RAISE EXCEPTION 'A stale season is not normalized on the regular table'; END IF;
  UPDATE public.player_game_stats SET points=13 WHERE id=identity;
  IF (SELECT points FROM analytics.player_season_totals WHERE player_id=player AND season_year=2097) IS DISTINCT FROM 13::numeric THEN RAISE EXCEPTION 'Update transition totals differ'; END IF;
  BEGIN
    INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number,points) VALUES(identity,player,other_game,2098,1,7);
    RAISE EXCEPTION 'Cross-season stat identity is accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE public.nba_games SET season_year=2098,game_date='2097-10-21',game_time='2097-10-21 22:00Z' WHERE id=game;
  IF (SELECT tableoid FROM public.player_game_stats WHERE id=identity)<>'public.player_game_stats'::regclass THEN RAISE EXCEPTION 'Calendar correction changes the physical table'; END IF;
  IF EXISTS(SELECT FROM analytics.player_season_totals WHERE player_id=player AND season_year=2097)
    OR (SELECT points FROM analytics.player_season_totals WHERE player_id=player AND season_year=2098) IS DISTINCT FROM 13::numeric THEN
    RAISE EXCEPTION 'Calendar correction loses transition totals';
  END IF;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES('002future-partition-a',2200,1,'2199-10-01','BOS','LAL','Scheduled'),('002future-partition-b',2201,1,'2200-10-01','BOS','LAL','Scheduled');
  IF to_regprocedure('private.ensure_player_stats_partition(integer)') IS NOT NULL OR to_regprocedure('private.retain_player_game_stats(timestamptz)') IS NOT NULL OR to_regclass('private.player_stats_partitions') IS NOT NULL THEN RAISE EXCEPTION 'Partition maintenance remains installed'; END IF;
  IF EXISTS(SELECT 1 FROM private.retention_rules WHERE relation_name LIKE 'public.player_game_stats_%' OR relation_name='public.player_game_stats' AND worker IS NOT NULL) THEN RAISE EXCEPTION 'Partition maintenance remains registered'; END IF;
  BEGIN
    PERFORM private.drop_expired_log_partitions('public.player_game_stats',now()+interval '100 years');
    RAISE EXCEPTION 'Durable stats are accepted as an expiring log';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'Unknown partition retention parent' THEN RAISE; END IF;
  END;
  DELETE FROM public.player_game_stats WHERE id=identity;
  IF EXISTS(SELECT FROM analytics.player_season_totals WHERE player_id=player) THEN RAISE EXCEPTION 'Delete transition totals differ'; END IF;
END;
$$;
ROLLBACK;
