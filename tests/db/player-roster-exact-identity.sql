BEGIN;
DO $$
DECLARE player uuid:=gen_random_uuid(); person text:=gen_random_uuid()::text; espn text:=gen_random_uuid()::text; result jsonb; current_game uuid:=gen_random_uuid(); old_game uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_team,nba_id,espn_id)
    VALUES(player,'Jaylen','Brown','PHI',person,espn);
  result:=public.resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id',espn,'first_name','Jalen','last_name','Brown','metadata',jsonb_build_object('nba_team','BOS'))));
  IF result->'results'->0->>'action' IS DISTINCT FROM 'ambiguous' OR NOT EXISTS(
    SELECT 1 FROM public.players WHERE id=player AND display_name='Jaylen Brown' AND nba_team='PHI') THEN
    RAISE EXCEPTION 'An ESPN identity collision rewrites Jaylen Brown';
  END IF;
  result:=public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id',espn,'display_name','Jalen Brown','nba_team','BOS')),true);
  IF result->'results'->0->>'action' IS DISTINCT FROM 'ambiguous' OR NOT EXISTS(
    SELECT 1 FROM public.players WHERE id=player AND nba_team='PHI') THEN
    RAISE EXCEPTION 'A linked roster identity collision changes Jaylen Brown team';
  END IF;
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(current_game,'002review-'||current_game::text,public.current_season_year_et(),1,(now() AT TIME ZONE 'America/New_York')::date,'BOS','BKN','Final'),
      (old_game,'002review-'||old_game::text,public.current_season_year_et(),1,(now() AT TIME ZONE 'America/New_York')::date-1,'PHI','NYK','Final');
  INSERT INTO private.player_game_memberships(player_id,game_id,nba_team)
    VALUES(player,current_game,'PHI'),(player,old_game,'PHI');
  result:=public.resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id',espn,'first_name','Jaylen','last_name','Brown','metadata',jsonb_build_object('nba_team','BOS'))));
  IF (result->'results'->0->>'player_id')::uuid IS DISTINCT FROM player OR NOT EXISTS(
    SELECT 1 FROM public.players p JOIN private.player_espn_listings l ON l.player_id=p.id
      WHERE p.id=player AND p.nba_team='BOS' AND l.nba_team='BOS') THEN
    RAISE EXCEPTION 'An exact identity fails to propagate a team change';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.player_game_memberships WHERE player_id=player AND game_id=current_game AND nba_team='BOS') THEN
    RAISE EXCEPTION 'Fresh listing fails to repair an impossible game team';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.player_game_memberships WHERE player_id=player AND game_id=old_game AND nba_team='PHI') THEN
    RAISE EXCEPTION 'A current listing rewrites a valid historical team';
  END IF;
END $$;
ROLLBACK;
SELECT 'player roster exact identity: 5 cases PASS';
