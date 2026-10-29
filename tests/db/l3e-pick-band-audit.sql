BEGIN;
SET LOCAL pg_stat_statements.track='none';
SET LOCAL auto_explain.log_min_duration=-1;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
WITH bands AS (
  SELECT league_id,value.draft_year,value.round,
    max(trade_value) FILTER(WHERE tier='early') AS early,
    max(trade_value) FILTER(WHERE tier='mid') AS mid,
    max(trade_value) FILTER(WHERE tier='late') AS late
  FROM public.get_pick_prediction_leagues() league_id
  CROSS JOIN LATERAL public.get_dynasty_pick_values(league_id) value
  GROUP BY league_id,value.draft_year,value.round
)
SELECT draft_year,round,early,mid,late FROM bands
WHERE early IS NULL OR mid IS NULL OR late IS NULL OR mid NOT BETWEEN LEAST(early,late) AND GREATEST(early,late)
ORDER BY draft_year,round;
ROLLBACK;
