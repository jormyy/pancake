BEGIN;
\ir rules-support.sql
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM pg_constraint
  WHERE conrelid='public.notification_outbox'::regclass AND conname='notification_outbox_trade_category'),
  'outbox keeps the original category constraint without a duplicate');
SELECT pg_temp.check_rules(to_regprocedure('public.clear_ineligible_taxi_players()') IS NULL,
  'the unused taxi clearing function is absent');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
