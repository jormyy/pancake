SELECT private.enqueue_rankings(now());
SELECT private.enqueue_projection_sync(now());
SELECT private.enqueue_daily(kind,6,0,((now() AT TIME ZONE 'America/New_York')::date+time '18:00') AT TIME ZONE 'America/New_York')
FROM unnest(ARRAY['sync-players','sync-trade-values','missing-final-stats','sync-schedule']) kind;
UPDATE private.work_items
SET status='succeeded',attempts=1,created_at=now()-interval '1 hour',due_at=now()-interval '1 hour',
    completed_at=now()-interval '1 hour',lease_token=NULL,lease_until=NULL,invocation_key=NULL,
    payload=payload||'{"gameNightSyntheticHistory":true}'::jsonb
WHERE kind IN ('sync-rankings','sync-players','sync-trade-values','missing-final-stats','sync-schedule') OR kind LIKE 'pt:%';
