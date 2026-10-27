BEGIN;
DO $$
DECLARE player uuid:=gen_random_uuid(); value jsonb;
BEGIN
 INSERT INTO players(id,first_name,last_name,nba_team) VALUES(player,'Injury','Details','BOS');
 SELECT to_jsonb(p) INTO value FROM public.view_player_search(p_include_player_ids:=ARRAY[player]) p;
 IF value->>'injury_reason' IS DISTINCT FROM 'unknown' OR value->>'injury_expected_return' IS DISTINCT FROM 'unknown' THEN RAISE EXCEPTION 'Missing injury details are not unknown'; END IF;
 UPDATE players SET injury_reason='Left ankle sprain',injury_expected_return='2026-11-02' WHERE id=player;
 SELECT to_jsonb(p) INTO value FROM public.view_player_search(p_include_player_ids:=ARRAY[player]) p;
 IF value->>'injury_reason' IS DISTINCT FROM 'Left ankle sprain' OR value->>'injury_expected_return' IS DISTINCT FROM '2026-11-02' THEN RAISE EXCEPTION 'Player search drops injury details'; END IF;
END;
$$;
ROLLBACK;
