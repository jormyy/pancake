BEGIN;
CREATE TEMP TABLE draft_timer_legacy_ids AS SELECT gen_random_uuid() AS user_id,gen_random_uuid() AS league_id,gen_random_uuid() AS season_id,gen_random_uuid() AS member_id,gen_random_uuid() AS draft_id;
ALTER TABLE drafts DROP CONSTRAINT drafts_pick_timer_seconds_range;
ALTER TABLE drafts ADD CONSTRAINT drafts_pick_timer_seconds_range CHECK(pick_timer_seconds BETWEEN 5 AND 3600) NOT VALID;
INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) SELECT user_id,'authenticated','authenticated',user_id||'@example.test','{}' FROM draft_timer_legacy_ids;
INSERT INTO leagues(id,name,slug,commissioner_id,status) SELECT league_id,'Synthetic legacy timer',league_id::text,user_id,'drafting' FROM draft_timer_legacy_ids;
INSERT INTO league_seasons(id,league_id,season_year,is_current) SELECT season_id,league_id,2189,true FROM draft_timer_legacy_ids;
INSERT INTO league_members(id,league_id,user_id,role) SELECT member_id,league_id,user_id,'commissioner' FROM draft_timer_legacy_ids;
INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,pick_timer_seconds,timer_paused_remaining_seconds) SELECT draft_id,league_id,season_id,'snake','paused',true,15,9 FROM draft_timer_legacy_ids;
\ir ../../supabase/migrations/20261020000200_rookie_draft_long_timers.sql
\ir ../../supabase/migrations/20261020000201_draft_cutoff_atomic_results.sql
\ir ../../supabase/migrations/20261020000202_draft_arm_after_lock.sql
\ir ../../supabase/migrations/20261020000203_draft_timer_insert_default.sql
DO $$
BEGIN
  IF NOT (SELECT pick_timer_seconds=60 AND timer_paused_remaining_seconds=9 AND status='paused' FROM drafts WHERE id=(SELECT draft_id FROM draft_timer_legacy_ids)) THEN
    RAISE EXCEPTION 'Legacy migration loses the saved clock or fails to raise its configured duration';
  END IF;
END;
$$;
ROLLBACK;
