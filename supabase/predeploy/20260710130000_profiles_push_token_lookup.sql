CREATE INDEX CONCURRENTLY IF NOT EXISTS profiles_push_token_lookup
  ON public.profiles (push_token)
  WHERE push_token IS NOT NULL;
