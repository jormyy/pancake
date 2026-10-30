BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_tag text := 'Identity' || replace(gen_random_uuid()::text,'-','');
  v_board jsonb;
  v_receipt jsonb;
  v_id uuid;
  v_person text;
  v_pick int;
  v_names text[] := ARRAY[v_tag||' Egor Demin',v_tag||' Yang Hansen',v_tag||' Walter Clayton Jr.',v_tag||' Nolan Traoré',v_tag||' Yanic Konan Niederhauser'];
  v_boxes text[] := ARRAY[v_tag||' Egor Dëmin',v_tag||' Yang Hansen',v_tag||' Walter Clayton Jr.',v_tag||' Nolan Traore',v_tag||' Yanic Konan Niederhäuser'];
  v_replayed uuid;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('display_name',CASE WHEN i<=5 THEN v_names[i] ELSE v_tag||' Prospect'||i END,'nba_draft_number',i) ORDER BY i)
  INTO v_board FROM generate_series(1,50) i;
  v_receipt:=resolve_player_imports_atomic('nba_draft',v_board);
  FOR v_pick IN 1..5 LOOP
    v_id:=(v_receipt->'results'->(v_pick-1)->>'player_id')::uuid;
    v_person:=v_tag||'-'||v_pick;
    v_replayed:=(resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object('provider_id',v_person,'display_name',v_boxes[v_pick])))->'results'->0->>'player_id')::uuid;
    IF v_replayed IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'First box forks draft identity for %',v_names[v_pick]; END IF;
    IF NOT EXISTS(SELECT FROM players WHERE id=v_id AND nba_id=v_person AND nba_draft_number=v_pick) THEN
      RAISE EXCEPTION 'First box does not link in place or loses pick %',v_pick;
    END IF;
    v_replayed:=(resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object('provider_id',v_person,'display_name',v_tag||' Renamed'||v_pick)))->'results'->0->>'player_id')::uuid;
    IF v_replayed IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'Provider identity fails after name change'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM players WHERE nba_id LIKE v_tag||'-%')<>5 THEN RAISE EXCEPTION 'Duplicate or missing rookie identity'; END IF;
  RAISE NOTICE 'PASS SYNTHETIC board with REAL-DERIVED name variants: first box, provider replay and pick continuity';
END $$;
ROLLBACK;
