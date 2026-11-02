BEGIN;
DELETE FROM private.work_items;
DO $$
DECLARE item bigint; token uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='io-hint-drain') THEN
    RAISE EXCEPTION 'The retired per-minute inventory drain remains scheduled';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='work-dispatcher' AND active) THEN
    RAISE EXCEPTION 'Inventory hints lost the shared dispatcher';
  END IF;
  item:=private.work_enqueue('league-inventory-hint-drain','inventory-sql-control',now(),'{"delay":0}');
  SELECT lease_token INTO token FROM private.work_claim(1) WHERE id=item;
  PERFORM private.work_execute(item,token);
  IF NOT EXISTS(SELECT 1 FROM private.work_items WHERE id=item AND status='succeeded')
    OR EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item) THEN
    RAISE EXCEPTION 'The immediate inventory drain does not finish as SQL work';
  END IF;
END $$;
ROLLBACK;
