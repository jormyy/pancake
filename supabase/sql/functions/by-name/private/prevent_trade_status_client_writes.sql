-- Canonical SQL source for private.prevent_trade_status_client_writes.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_trade_status_client_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid;
BEGIN
  v_caller := (SELECT auth.uid());

  -- Service role / internal SECURITY DEFINER RPCs run with auth.uid() = NULL.
  -- All legitimate status transitions (accept / complete / veto / reject /
  -- withdraw) flow through service-role paths, so we trust them. Server-owned
  -- lifecycle code that runs inside an authenticated transaction (the roster
  -- lifecycle trigger expiring an offer whose asset just left a roster) marks
  -- itself with the transaction-local app.trade_lifecycle_server_write flag.
  IF v_caller IS NULL
     OR current_setting('app.trade_lifecycle_server_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- Authenticated end-user path: any change to status or to a
  -- lifecycle timestamp is forbidden. These are exclusively owned by
  -- the atomic RPCs and backend routes.
  IF NEW.status                 IS DISTINCT FROM OLD.status
     OR NEW.accepted_at            IS DISTINCT FROM OLD.accepted_at
     OR NEW.veto_window_expires_at IS DISTINCT FROM OLD.veto_window_expires_at
     OR NEW.completed_at           IS DISTINCT FROM OLD.completed_at
     OR NEW.vetoed_at              IS DISTINCT FROM OLD.vetoed_at
  THEN
    RAISE EXCEPTION
      'Trade status and lifecycle timestamps can only be changed via the trade RPCs.'
      USING ERRCODE = '42501';
  END IF;

  -- Also forbid rewriting the trade parties themselves. The WITH CHECK
  -- on the policy already prevents reassignment AWAY from the caller,
  -- but defense-in-depth: forbid any change to proposer/recipient or
  -- league/season scoping fields from the client path entirely.
  IF NEW.proposer_member_id  IS DISTINCT FROM OLD.proposer_member_id
     OR NEW.recipient_member_id IS DISTINCT FROM OLD.recipient_member_id
     OR NEW.league_id           IS DISTINCT FROM OLD.league_id
     OR NEW.league_season_id    IS DISTINCT FROM OLD.league_season_id
     OR NEW.proposed_at          IS DISTINCT FROM OLD.proposed_at
  THEN
    RAISE EXCEPTION
      'Trade identity fields are immutable from client-side updates.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
