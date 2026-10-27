\ir idempotency-support.sql
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  PERFORM pg_temp.retry('announcement', f.user_ids[1], format('public.notif_publish_announcement_atomic(%L,%L,$request)', f.league_id,'Saved announcement'), 'public.notif_publish_announcement_atomic');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM league_announcements WHERE league_id=f.league_id), 'one announcement');
END;
$$;
\ir idempotency-cleanup.sql
