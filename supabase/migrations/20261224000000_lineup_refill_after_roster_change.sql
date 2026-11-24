BEGIN;

CREATE TABLE private.lineup_refill_requests(
  member_id uuid PRIMARY KEY REFERENCES public.league_members(id) ON DELETE CASCADE,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz
);
ALTER TABLE private.lineup_refill_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.lineup_refill_requests FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.work_kinds(kind, function_name) VALUES ('lineup-refill', 'lineup-optimizer')
ON CONFLICT (kind) DO NOTHING;

CREATE OR REPLACE FUNCTION private.ensure_lineup_refill_queued()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM private.lineup_refill_requests
     WHERE claimed_at IS NULL OR claimed_at < clock_timestamp() - interval '10 minutes'
  ) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM private.work_items WHERE kind = 'lineup-refill' AND status IN ('pending', 'failed')) THEN
    RETURN;
  END IF;
  PERFORM private.work_enqueue('lineup-refill', gen_random_uuid()::text, now() + interval '15 seconds',
    jsonb_build_object('mode', 'roster_refill', 'queuedAt', clock_timestamp()));
END;
$$;

CREATE OR REPLACE FUNCTION private.request_lineup_refill(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings s
      JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
      JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs') AND l.deleted_at IS NULL
     WHERE s.league_id = p_league_id AND s.league_season_id = p_league_season_id
       AND s.member_id = p_member_id AND s.enabled
  ) THEN RETURN; END IF;
  INSERT INTO private.lineup_refill_requests(member_id, league_id, league_season_id, requested_at)
  VALUES (p_member_id, p_league_id, p_league_season_id, clock_timestamp())
  ON CONFLICT (member_id) DO UPDATE SET league_id = EXCLUDED.league_id,
    league_season_id = EXCLUDED.league_season_id, requested_at = EXCLUDED.requested_at;
  PERFORM private.ensure_lineup_refill_queued();
END;
$$;

CREATE OR REPLACE FUNCTION private.roster_change_requests_lineup_refill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM private.request_lineup_refill(NEW.league_id, NEW.league_season_id, NEW.member_id);
    END IF;
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_season_id) IS DISTINCT FROM (NEW.member_id, NEW.league_season_id)) THEN
      PERFORM private.request_lineup_refill(OLD.league_id, OLD.league_season_id, OLD.member_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Lineup refill request skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER z_request_lineup_refill
AFTER INSERT OR DELETE OR UPDATE OF member_id, league_season_id, is_on_ir, is_on_taxi ON public.roster_players
FOR EACH ROW EXECUTE FUNCTION private.roster_change_requests_lineup_refill();

CREATE OR REPLACE FUNCTION public.claim_lineup_refills(p_limit integer DEFAULT 1)
RETURNS TABLE(member_id uuid, league_id uuid, league_season_id uuid, requested_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM private.lineup_refill_requests r
   WHERE NOT EXISTS (
     SELECT 1 FROM public.lineup_optimizer_settings s
      WHERE s.league_id = r.league_id AND s.league_season_id = r.league_season_id
        AND s.member_id = r.member_id AND s.enabled
   );
  RETURN QUERY
  UPDATE private.lineup_refill_requests r SET claimed_at = clock_timestamp()
    FROM (
      SELECT q.member_id FROM private.lineup_refill_requests q
       WHERE q.claimed_at IS NULL OR q.claimed_at < clock_timestamp() - interval '10 minutes'
       ORDER BY q.requested_at, q.member_id
       LIMIT greatest(1, least(p_limit, 20))
       FOR UPDATE SKIP LOCKED
    ) due
   WHERE r.member_id = due.member_id
  RETURNING r.member_id, r.league_id, r.league_season_id, r.requested_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_lineup_refill(p_member_id uuid, p_requested_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM private.lineup_refill_requests
   WHERE member_id = p_member_id AND requested_at = p_requested_at;
  UPDATE private.lineup_refill_requests SET claimed_at = NULL
   WHERE member_id = p_member_id AND requested_at <> p_requested_at;
  PERFORM private.ensure_lineup_refill_queued();
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_lineup_refill_queued() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.request_lineup_refill(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.roster_change_requests_lineup_refill() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_lineup_refills(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_lineup_refill(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lineup_refills(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_lineup_refill(uuid, timestamptz) TO service_role;

COMMIT;
