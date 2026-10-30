BEGIN;
\ir rules-support.sql
SET LOCAL app.supabase_url='http://127.0.0.1:64821';
SET LOCAL app.edge_internal_token='private-pipeline-night';
CREATE FUNCTION pg_temp.mix_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT current_setting('pipeline.mix_clock')::timestamptz
$$;
SELECT set_config('pipeline.mix_clock','2026-10-30T12:40:00Z',true);
ALTER TABLE private.work_kinds ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz;
UPDATE private.work_kinds SET last_claimed_at=NULL;
DELETE FROM private.work_items;
DELETE FROM private.trade_revaluation_leagues;
DELETE FROM private.forecast_refresh_requests;
DELETE FROM private.matchup_forecast_expiries;
UPDATE private.matchup_forecast_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_revision=NULL;
INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
  SELECT 'matchup:'||id,id,'2026-10-30T06:19:16.613194Z' FROM public.matchups ORDER BY id LIMIT 82;
INSERT INTO private.work_items(kind,key,status,attempts,due_at,payload,lease_token,lease_until)
  SELECT 'stats-sync','mix-holder-'||n,'running',1,pg_temp.mix_now(),jsonb_build_object('holder',n),
    gen_random_uuid(),pg_temp.mix_now()+interval '5 minutes' FROM generate_series(1,2) n;
INSERT INTO private.work_items(kind,key,due_at,payload)
  SELECT 'trade-revaluation-check','mix-old-check-'||n,'2026-10-30T05:33:02Z'::timestamptz+n*interval '1 millisecond',
    jsonb_build_object('replay','old-check','n',n) FROM generate_series(1,330) n;
INSERT INTO private.work_items(kind,key,due_at,status,attempts,last_error,payload)
  SELECT 'trade-revaluation-check','mix-failed-check-'||n,'2026-10-30T06:18:00Z','failed',1,'Worker lease expired',
    jsonb_build_object('replay','failed-check','n',n) FROM generate_series(1,7) n;
INSERT INTO private.work_items(kind,key,due_at,payload)
  SELECT 'trade-revaluation-scan','mix-old-scan-'||n,'2026-10-30T05:37:00Z'::timestamptz+n*interval '1 millisecond',
    jsonb_build_object('replay','scan','n',n) FROM generate_series(1,41) n;
INSERT INTO private.work_items(kind,key,due_at,status,attempts,last_error,payload)
  VALUES('trade-revaluation-scan','mix-failed-scan','2026-10-30T06:18:00Z','failed',1,'Worker lease expired','{"replay":"failed-scan"}');
INSERT INTO private.work_items(kind,key,due_at,payload)
  SELECT 'trade-revaluation','mix-old-revaluation-'||n,'2026-10-30T05:37:01Z'::timestamptz+n*interval '1 millisecond',
    jsonb_build_object('replay','revaluation','n',n) FROM generate_series(1,8) n;
INSERT INTO private.work_items(kind,key,due_at,payload) VALUES
  ('notification-scan','mix-notification-7514','2026-10-30T06:21:00Z','{"schedulerChunk":"notifications","at":"2026-10-30T12:38:00Z"}'),
  ('forecast-inputs','mix-inputs-7519','2026-10-30T06:42:00Z','{"schedulerChunk":"forecasts"}');
CREATE TEMP TABLE mix_claims(tick integer,ordinal integer,kind text,key text,attempts integer,bypassed_older integer);
CREATE TEMP TABLE mix_snapshots(tick integer,value jsonb);
DO $$
DECLARE claimed private.work_items%ROWTYPE; ordinal integer:=0; older integer; remaining integer;
BEGIN
  FOR tick IN 1..240 LOOP
    PERFORM set_config('pipeline.mix_clock',('2026-10-30T12:40:00Z'::timestamptz+(tick-1)*interval '1 minute')::text,true);
    UPDATE private.work_items SET lease_until=pg_temp.mix_now()+interval '5 minutes' WHERE key LIKE 'mix-holder-%';
    IF EXISTS(SELECT 1 FROM private.forecast_refresh_requests) THEN
      PERFORM private.work_enqueue('matchup-forecasts','mix-empty-'||tick,pg_temp.mix_now(),jsonb_build_object('tick',tick));
    END IF;
    PERFORM private.work_enqueue('trade-revaluation-check','mix-new-check-'||tick,pg_temp.mix_now(),jsonb_build_object('replay','new-check','tick',tick));
    IF tick%15=0 THEN
      PERFORM private.work_enqueue('trade-estimate','mix-urgent-'||tick,pg_temp.mix_now(),jsonb_build_object('urgent',tick));
    END IF;
    FOR claimed IN SELECT * FROM private.work_claim(2) LOOP
      ordinal:=ordinal+1;
      SELECT count(*) INTO older FROM private.work_items WHERE kind=claimed.kind AND status IN('pending','failed')
        AND due_at<=pg_temp.mix_now() AND (due_at,id)<(claimed.due_at,claimed.id);
      INSERT INTO mix_claims VALUES(tick,ordinal,claimed.kind,claimed.key,claimed.attempts,older);
    END LOOP;
    FOR claimed IN SELECT * FROM private.work_items WHERE status='running' AND key NOT LIKE 'mix-holder-%' LOOP
      IF claimed.kind='forecast-inputs' THEN DELETE FROM private.forecast_refresh_requests; END IF;
      PERFORM private.work_finish(claimed.id,claimed.lease_token);
    END LOOP;
    IF tick IN(1,3,6,12,60,120,180,240) THEN
      INSERT INTO mix_snapshots SELECT tick,jsonb_build_object('oldChecks',count(*) FILTER(WHERE key LIKE 'mix-old-check-%'),
        'notification',count(*) FILTER(WHERE kind='notification-scan'),'inputs',count(*) FILTER(WHERE kind='forecast-inputs'),
        'scans',count(*) FILTER(WHERE kind='trade-revaluation-scan'),'revaluations',count(*) FILTER(WHERE kind='trade-revaluation'))
        FROM private.work_items WHERE status IN('pending','failed');
    END IF;
    SELECT count(*) INTO remaining FROM private.work_items WHERE status IN('pending','failed')
      AND key !~ '^mix-(holder|new-check|empty|urgent)-';
    EXIT WHEN remaining=0;
  END LOOP;
END;
$$;
SELECT jsonb_build_object('first',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY ordinal) FROM mix_claims c WHERE ordinal<=20),'[]'),
  'byKind',(SELECT jsonb_object_agg(kind,value) FROM (SELECT kind,jsonb_build_object('firstTick',min(tick),'lastTick',max(tick),'count',count(*)) AS value FROM mix_claims GROUP BY kind) s),
  'oldChecksCompleted',(SELECT count(*) FROM private.work_items WHERE key LIKE 'mix-old-check-%' AND status='succeeded'),
  'failedChecksCompleted',(SELECT count(*) FROM private.work_items WHERE key LIKE 'mix-failed-check-%' AND status='succeeded' AND attempts=2),
  'failedScanCompleted',(SELECT count(*) FROM private.work_items WHERE key='mix-failed-scan' AND status='succeeded' AND attempts=2),
  'checkBypasses',(SELECT coalesce(sum(bypassed_older),0) FROM mix_claims WHERE kind='trade-revaluation-check'),
  'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY tick) FROM mix_snapshots s),
  'remaining',(SELECT jsonb_object_agg(kind,n) FROM (SELECT kind,count(*) n FROM private.work_items WHERE status IN('pending','failed') GROUP BY kind) s));
ROLLBACK;
