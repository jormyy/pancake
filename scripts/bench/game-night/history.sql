SELECT private.enqueue_rankings(now());
SELECT private.enqueue_projection_sync(now());
UPDATE private.work_items
SET status='succeeded',attempts=1,created_at=now()-interval '1 hour',due_at=now()-interval '1 hour',
    completed_at=now()-interval '1 hour',lease_token=NULL,lease_until=NULL,invocation_key=NULL,
    payload=payload||'{"gameNightSyntheticHistory":true}'::jsonb
WHERE kind='sync-rankings' OR kind LIKE 'pt:%';
