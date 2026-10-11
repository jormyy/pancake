-- A rookie board can only describe a class that has not played yet. A board that matches an experienced player
-- (a past year's board or a wrong identity) is refused whole: no experience reset, no draft numbers cleared.
BEGIN;
DO $$
DECLARE
  v_rows jsonb := '[]'::jsonb; v_veteran uuid := gen_random_uuid(); v_current uuid := gen_random_uuid();
  v_failed boolean := false; i int;
BEGIN
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
  VALUES(v_veteran,'Fence','Veteran Guard','PG',ARRAY['PG'],6,NULL),
        (v_current,'Fence','Current Rookie','SG',ARRAY['SG'],0,17);
  FOR i IN 1..50 LOOP
    INSERT INTO players(first_name,last_name,position,eligible_positions,years_exp)
    VALUES('Fence','Prospect '||i,'SF',ARRAY['SF'],0);
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('display_name','Fence Prospect '||i,'nba_draft_number',i));
  END LOOP;
  -- Pick 50 names the veteran, as a past class board would.
  v_rows := jsonb_set(v_rows,'{49,display_name}','"Fence Veteran Guard"');
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_draft',v_rows);
  EXCEPTION WHEN SQLSTATE '23514' THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'REPRODUCED: a board naming an experienced player replaced the draft board'; END IF;
  IF (SELECT years_exp FROM players WHERE id=v_veteran) <> 6 THEN RAISE EXCEPTION 'Refused board still reset veteran experience'; END IF;
  IF (SELECT nba_draft_number FROM players WHERE id=v_current) IS DISTINCT FROM 17 THEN
    RAISE EXCEPTION 'Refused board still cleared a current draft number';
  END IF;
  -- Control: a board of players who have not played imports normally.
  v_rows := jsonb_set(v_rows,'{49,display_name}','"Fence Prospect 50"');
  PERFORM resolve_player_imports_atomic('nba_draft',v_rows);
  IF (SELECT count(*) FROM players WHERE display_name LIKE 'Fence Prospect %' AND nba_draft_number IS NOT NULL) <> 50 THEN
    RAISE EXCEPTION 'A valid all-rookie board did not import';
  END IF;
END;
$$;
ROLLBACK;
