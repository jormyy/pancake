SET lock_timeout = '5s';
SET statement_timeout = '2min';

-- Production creates this index concurrently through the matching predeploy
-- script. This statement records a fresh-database fallback and is a no-op in
-- the production migration transaction.
CREATE INDEX IF NOT EXISTS profiles_push_token_lookup
  ON public.profiles (push_token)
  WHERE push_token IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
