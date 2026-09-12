\set ON_ERROR_STOP off
\echo ==== P2 ops#7 live-poll lease: a slow holder is overtaken after the 90s TTL with no renewal
SELECT public.try_live_poll_lease(999001, 90) IS NOT NULL AS first_holder_acquired;
SELECT public.try_live_poll_lease(999001, 90) IS NULL AS second_caller_refused_inside_ttl;
SELECT count(*) AS renew_functions FROM pg_proc WHERE proname ILIKE '%renew%lease%';
SELECT pg_sleep(91);
SELECT public.try_live_poll_lease(999001, 90) IS NOT NULL AS third_caller_took_over_while_first_never_released;
DELETE FROM public.live_poll_leases WHERE lock_key = 999001;
