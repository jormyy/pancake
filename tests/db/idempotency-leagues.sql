\ir idempotency-support.sql
UPDATE leagues SET status='setup', invite_code=upper(substr(replace(id::text,'-',''),1,16)) WHERE id=(SELECT league_id FROM idempotency_fixture);
DELETE FROM waiver_priorities WHERE member_id=(SELECT member_ids[3] FROM idempotency_fixture);
DELETE FROM faab_balances WHERE member_id=(SELECT member_ids[3] FROM idempotency_fixture);
DELETE FROM league_members WHERE id=(SELECT member_ids[3] FROM idempotency_fixture);
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  PERFORM pg_temp.retry('league create', f.user_ids[1], 'public.create_league(''Retry league'', ''Retry team'', 200)', 'public.create_league');
  PERFORM pg_temp.retry('league join', f.user_ids[3], format('public.join_league_by_invite_code(%L,%L)',(SELECT invite_code FROM leagues WHERE id=f.league_id),'Joined team'), 'public.join_league_by_invite_code');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM leagues WHERE commissioner_id=f.user_ids[1]), 'one new league');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM league_members WHERE league_id=f.league_id AND user_id=f.user_ids[3]), 'one joined member');
END;
$$;
\ir idempotency-cleanup.sql
