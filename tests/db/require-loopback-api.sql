\getenv loopback_api_url SUPABASE_URL
\if :{?loopback_api_url}
\else
\set loopback_api_url ''
\endif
SELECT set_config('test.loopback_api_url', :'loopback_api_url', true);
DO $$ BEGIN
  IF current_setting('test.loopback_api_url') !~ '^http://(127[.]0[.]0[.]1|localhost):[0-9]+/?$' THEN
    RAISE EXCEPTION 'Set SUPABASE_URL to the private loopback API before this recipe';
  END IF;
END $$;
SELECT set_config('app.supabase_url', current_setting('test.loopback_api_url'), true);
