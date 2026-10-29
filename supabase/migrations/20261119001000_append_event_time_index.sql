BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE INDEX league_events_created_at_brin ON public.league_events USING brin(created_at)
WITH (pages_per_range=32,autosummarize=on);
COMMIT;
