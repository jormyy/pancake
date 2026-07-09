-- Canonical SQL source for private.prevent_insert_self_commissioner.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_insert_self_commissioner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  -- Only act on attempts to insert a privileged role. The default
  -- 'manager' role is fine for any authenticated user (the existing
  -- league_members_insert RLS policy already restricts WITH CHECK
  -- (auth.uid() = user_id), so they can only insert their own row).
  IF NEW.role NOT IN ('commissioner', 'co_commissioner') THEN
    RETURN NEW;
  END IF;

  v_caller := (SELECT auth.uid());

  -- Bypass 1: service_role / internal callers have no auth.uid().
  -- The backend (service_role key) bypasses RLS but triggers still
  -- fire, so we must allow this path.
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Bypass 2: an existing commissioner of this league is allowed to
  -- insert a co-commissioner (or add another commissioner — same
  -- policy as the UPDATE OF role trigger from migration 260000).
  IF private.is_commissioner(NEW.league_id) THEN
    RETURN NEW;
  END IF;

  -- Bypass 3: bootstrap. The very first member row for a league is
  -- inserted by the create_league SECURITY DEFINER RPC, which runs
  -- with auth.uid() = the caller's uid (the JWT travels through the
  -- DEFINER context). At that point is_commissioner returns false
  -- because no league_members rows exist yet. To allow the bootstrap
  -- without opening a hole, require that:
  --   (a) NO league_members row exists for this league yet, AND
  --   (b) the leagues row's commissioner_id matches NEW.user_id.
  -- The create_league RPC inserts the leagues row first, setting
  -- commissioner_id = auth.uid(), so this clause matches. An
  -- attacker cannot satisfy (a)+(b) against a victim's league
  -- because the victim's league already has a commissioner row.
  IF NOT EXISTS (
    SELECT 1
    FROM   public.league_members lm
    WHERE  lm.league_id = NEW.league_id
  )
  AND EXISTS (
    SELECT 1
    FROM   public.leagues l
    WHERE  l.id              = NEW.league_id
      AND  l.commissioner_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  -- No bypass matched: this is an escalation attempt.
  RAISE EXCEPTION
    'Only commissioners can grant the commissioner or co-commissioner role.'
    USING ERRCODE = '42501';
END;
$$;
