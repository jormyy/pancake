\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE scheduled bigint;
BEGIN
  IF to_regprocedure('private.enqueue_rankings(timestamptz)') IS NULL
    OR NOT EXISTS(SELECT FROM private.work_kinds WHERE kind='sync-rankings') THEN
    RAISE EXCEPTION 'The restored rankings scheduler is missing';
  END IF;
  DELETE FROM private.work_items WHERE kind IN('missing-final-stats','sync-rankings');
  PERFORM private.enqueue_scheduled_work('2098-10-28 08:00:00+00');
  PERFORM private.enqueue_scheduled_work('2098-10-28 11:00:00+00');
  SELECT count(*) INTO scheduled FROM private.work_items WHERE kind='missing-final-stats' AND key='2098-10-28';
  IF scheduled=0 THEN RAISE EXCEPTION 'Daily missing-final reconciliation is not scheduled'; END IF;
  IF (SELECT count(*) FROM private.work_items WHERE kind='sync-rankings')<>3 THEN RAISE EXCEPTION 'Restored ranking views are not scheduled'; END IF;
  PERFORM private.enqueue_scheduled_work('2098-10-28 08:00:00+00');
  PERFORM private.enqueue_scheduled_work('2098-10-28 11:00:00+00');
  IF (SELECT count(*) FROM private.work_items WHERE kind='missing-final-stats' AND key='2098-10-28')<>scheduled THEN RAISE EXCEPTION 'Reconciliation enqueue duplicates work'; END IF;
END;
$$;
ROLLBACK;
