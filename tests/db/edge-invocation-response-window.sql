BEGIN;
SET LOCAL statement_timeout = '30s';
UPDATE public.edge_invocations SET reconciled_at=now() WHERE reconciled_at IS NULL;
INSERT INTO public.edge_invocations(function_name,request_id,queued_at)
  VALUES('reconcile-response-window',991005501,now()-interval '5 minutes');
INSERT INTO net._http_response(id,status_code,content,timed_out,created) VALUES
  (991005501,500,'stale response',false,now()-interval '1 day'),
  (991005501,200,'current response',false,now()-interval '4 minutes');
DO $$
BEGIN
  IF private.reconcile_edge_invocations() <> 1 THEN
    RAISE EXCEPTION 'Reconciliation reads an old response outside the locked batch window';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE function_name='reconcile-response-window'
    AND status_code=200 AND reconciled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Current response is not reconciled';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sync_runs WHERE function_name='cron:reconcile-response-window') THEN
    RAISE EXCEPTION 'An old response creates a false failure';
  END IF;
END $$;
ROLLBACK;
