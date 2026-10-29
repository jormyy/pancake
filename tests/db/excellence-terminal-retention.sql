\set ON_ERROR_STOP on
BEGIN;
DELETE FROM private.work_items;
INSERT INTO private.work_items(kind,key,status,completed_at,attempts) VALUES
('player-stats-hints','expired-success','succeeded',now()-interval '8 days',1),
('player-stats-hints','boundary-success','succeeded',now()-interval '7 days',1),
('player-stats-hints','expired-dead','dead',now()-interval '91 days',3),
('player-stats-hints','boundary-dead','dead',now()-interval '90 days',3),
('player-stats-hints','old-pending','pending',NULL,0),
('sync-schedule','old-failed','failed',NULL,1);
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT private.retain_work_items(now());
DO $$
BEGIN
  IF (SELECT count(*) FROM private.work_items)<>4 OR
    EXISTS(SELECT 1 FROM private.work_items WHERE key IN('expired-success','expired-dead')) THEN
    RAISE EXCEPTION 'Terminal retention loses its boundaries or keeps expired work';
  END IF;
END;
$$;
INSERT INTO private.work_items(kind,key,status,completed_at,attempts)
SELECT 'player-stats-hints','batch-'||id::text,'dead',now()-interval '91 days',3 FROM generate_series(1,5001) id;
SELECT private.retain_work_items(now());
DO $$
BEGIN
  IF (SELECT count(*) FROM private.work_items WHERE key LIKE 'batch-%')<>1 THEN
    RAISE EXCEPTION 'Terminal retention does not honor the 5000-row bound';
  END IF;
END;
$$;
ROLLBACK;
