BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_remaining int;
  v_deadline timestamptz;
  v_reference timestamptz;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(v_league,'Synthetic timer pause',v_league::text,v_user,'drafting');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2189,true);
  INSERT INTO league_members(id,league_id,user_id,role) VALUES(v_member,v_league,v_user,'commissioner');
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,pick_timer_seconds) VALUES(v_draft,v_league,v_season,'snake','in_progress',true,60);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id) VALUES(v_draft,1,1,1,v_member);
  PERFORM pg_sleep(1.1);
  UPDATE snake_draft_picks SET timer_expires_at = clock_timestamp() + interval '10.25 seconds' WHERE draft_id = v_draft;
  PERFORM pause_draft_atomic(v_draft);
  SELECT timer_paused_remaining_seconds INTO v_remaining FROM drafts WHERE id = v_draft;
  IF v_remaining <> 11 THEN RAISE EXCEPTION 'Pause stores stale time: expected 11, got %',v_remaining; END IF;
  IF EXISTS(SELECT 1 FROM snake_draft_picks WHERE draft_id=v_draft AND timer_expires_at IS NOT NULL) THEN RAISE EXCEPTION 'Paused deadline remains armed'; END IF;
  v_reference := clock_timestamp();
  PERFORM resume_draft_atomic(v_draft);
  SELECT timer_expires_at INTO v_deadline FROM snake_draft_picks WHERE draft_id=v_draft;
  IF extract(epoch FROM v_deadline-v_reference) NOT BETWEEN 10.95 AND 11.1 THEN RAISE EXCEPTION 'Resume loses saved duration'; END IF;
  v_reference := clock_timestamp();
  PERFORM reset_draft_atomic(v_draft);
  SELECT timer_expires_at INTO v_deadline FROM snake_draft_picks WHERE draft_id=v_draft;
  IF extract(epoch FROM v_deadline-v_reference) NOT BETWEEN 59.95 AND 60.1 THEN RAISE EXCEPTION 'Reset loses time from the current transaction'; END IF;
END;
$$;
ROLLBACK;
