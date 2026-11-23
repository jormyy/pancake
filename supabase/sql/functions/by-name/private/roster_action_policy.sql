-- Canonical SQL source for private.roster_action_policy.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.roster_action_policy()
RETURNS TABLE(action private.roster_action, hold private.roster_hold, errcode text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT cell.action::private.roster_action, cell.hold::private.roster_hold, cell.errcode
  FROM (VALUES
    ('drop','offer_pending','PA004'),('drop','trade_reserved','PA004'),('drop','claim_reserved','PA004'),
    ('lineup_move','offer_pending',NULL),('lineup_move','trade_reserved',NULL),('lineup_move','claim_reserved',NULL),
    ('to_ir','offer_pending','PA004'),('to_ir','trade_reserved','PA004'),('to_ir','claim_reserved','PA004'),
    ('from_ir','offer_pending','PA004'),('from_ir','trade_reserved','PA004'),('from_ir','claim_reserved','PA004'),
    ('to_taxi','offer_pending','PA004'),('to_taxi','trade_reserved','PA004'),('to_taxi','claim_reserved','PA004'),
    ('from_taxi','offer_pending','PA004'),('from_taxi','trade_reserved','PA004'),('from_taxi','claim_reserved','PA004'),
    ('transfer','offer_pending','PA004'),('transfer','trade_reserved','PA004'),('transfer','claim_reserved','PA004'),
    ('trade_move','offer_pending',NULL),('trade_move','trade_reserved','PA004'),('trade_move','claim_reserved','PA004'),
    ('trade_offer','offer_pending',NULL),('trade_offer','trade_reserved','PA004'),('trade_offer','claim_reserved','PA004'),
    ('trade_plan','offer_pending','PA004'),('trade_plan','trade_reserved','PA004'),('trade_plan','claim_reserved','PA004'),
    ('trade_accept','offer_pending',NULL),('trade_accept','trade_reserved','PA004'),('trade_accept','claim_reserved',NULL),
    ('claim_add','offer_pending','PA004'),('claim_add','trade_reserved','PA004'),('claim_add','claim_reserved',NULL),
    ('claim_drop','offer_pending','PA004'),('claim_drop','trade_reserved','PA004'),('claim_drop','claim_reserved',NULL)
  ) AS cell(action, hold, errcode)
$$;
