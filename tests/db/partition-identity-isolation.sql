\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
\ir excellence-fixture.sql
DO $$
DECLARE dedupe text:=gen_random_uuid()::text; member uuid; player uuid; game uuid; season integer;
BEGIN
  SELECT id INTO STRICT member FROM public.league_members ORDER BY id LIMIT 1;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  VALUES(dedupe,member,'isolation-fixture','same','same','{}','draft');
  BEGIN
    INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,created_at)
    VALUES(dedupe,member,'isolation-fixture','same','same','{}','draft',now()-interval '1 year');
    RAISE EXCEPTION 'A stale transaction snapshot can bypass outbox uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  player:=gen_random_uuid();
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Isolation','Stats');
  SELECT id,season_year INTO STRICT game,season FROM public.nba_games ORDER BY id LIMIT 1;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number) VALUES(player,game,season,1);
  BEGIN
    INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number)
    VALUES(player,game,season,1);
    RAISE EXCEPTION 'A stale transaction snapshot can bypass stats uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;
ROLLBACK;
