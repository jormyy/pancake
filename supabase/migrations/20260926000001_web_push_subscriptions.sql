SET lock_timeout = '5s';
SET statement_timeout = '2min';

-- Standards Web Push subscriptions for the installed PWA. A user may hold one
-- per browser/device; Expo tokens stay on profiles.push_token for native.
-- Clients never touch this table directly: the Edge API validates and writes
-- rows with the service role, and the endpoint URL is a delivery capability.
CREATE TABLE public.web_push_subscriptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_push_subscriptions_endpoint_format CHECK (
    endpoint ~ '^https://' AND octet_length(endpoint) <= 2048
  ),
  -- base64url without padding: 65-byte P-256 point and 16-byte auth secret.
  CONSTRAINT web_push_subscriptions_p256dh_format CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  CONSTRAINT web_push_subscriptions_auth_format CHECK (auth ~ '^[A-Za-z0-9_-]{22}$')
);

CREATE INDEX web_push_subscriptions_user_id_idx
  ON public.web_push_subscriptions (user_id, updated_at DESC);

ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.web_push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.web_push_subscriptions TO service_role;

RESET statement_timeout;
RESET lock_timeout;
