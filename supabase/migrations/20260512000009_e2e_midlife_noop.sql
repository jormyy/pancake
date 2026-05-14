-- No-op schema migration used by the multi-season soak harness to verify
-- D.LONG.5: an additive/no-op migration can be applied mid-life without
-- corrupting dynasty state.
--
-- This intentionally changes no application tables. Supabase records the
-- migration version in its migration history when `supabase db push` applies it.
SELECT 1;
