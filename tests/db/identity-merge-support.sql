BEGIN;
DO $$
DECLARE
  v_board uuid := gen_random_uuid();
  v_box uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_rank uuid := gen_random_uuid();
  v_projection uuid := gen_random_uuid();
  v_person text := 'identity-merge-' || v_box::text;
BEGIN
  INSERT INTO players(id,first_name,last_name,nba_draft_number,years_exp)
  VALUES(v_board,'Egor','Demin',8,0);
  INSERT INTO players(id,first_name,last_name,nba_id)
  VALUES(v_box,'Egor','Dëmin',v_person);
  INSERT INTO dynasty_rankings(id,source,source_rank,source_player_name,player_id)
  VALUES(v_rank,v_rank::text,1,'Egor Demin',v_board);
  INSERT INTO projection_sync_runs(id,projection_type,source_url)
  VALUES(v_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php');
  INSERT INTO fantasypros_projection_rows(id,run_id,projection_type,source_url,source_row_number,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
  VALUES(v_projection,v_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',1,
    now(),'Egor Demin','egor demin',v_board,'matched',17);
  PERFORM assign_player_nba_id_atomic(v_board,v_person);
  IF (SELECT player_id FROM dynasty_rankings WHERE id=v_rank) IS DISTINCT FROM v_box THEN
    RAISE EXCEPTION 'Identity merge loses the rookie ranking player link';
  END IF;
  IF (SELECT player_id FROM fantasypros_projection_rows WHERE id=v_projection) IS DISTINCT FROM v_box THEN
    RAISE EXCEPTION 'Identity merge loses the rookie projection player link';
  END IF;
  IF (SELECT nba_draft_number FROM players WHERE id=v_box) IS DISTINCT FROM 8
    OR EXISTS(SELECT FROM players WHERE id=v_board) THEN
    RAISE EXCEPTION 'Identity merge loses the draft pick or leaves a duplicate';
  END IF;
  RAISE NOTICE 'PASS SYNTHETIC duplicate recovery keeps ranking, projection and draft history';
END $$;
ROLLBACK;
