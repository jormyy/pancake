SELECT pg_advisory_xact_lock(hashtextextended('public.dispatch_work',0));
DELETE FROM private.cron_dispatch_claims;
