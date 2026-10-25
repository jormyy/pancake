# Release database contract

## Release order for this release

Database, then Edge, then merge the frontend.
Production currently stops at migration `20261020000007`.
This release advances the database through migration `20261026001000`.
Production has 431 applied versions; `origin/main` contains 494 migrations.
The push applies 63 pending main migrations, from `20261020000030` through `20261024000001`, first.
It then applies the 54 unpublished migrations listed below, in version order.
The approved plan and [attestations](../docs/release-history-attestations.md) define the exact applied and pending ranges.
The Vercel integration publishes the frontend when this release merges into main.
Do not merge before the database and Edge checks pass.

The existing production workflow requires a commit already on main.
That requirement cannot establish this release's safe order while merge still deploys the frontend.
The release operator must run the approved database and Edge phases from the reviewed release commit before merging.
The owner decides whether to change the deploy integration or approve that separate production run.
Do not bypass production approvals or merge merely to satisfy the workflow's ancestry check.

1. Freeze the reviewed release commit and record the deployed frontend and Edge provenance.
   Run `npm ci`, `npm run check:quality`, `npm test`, and `npm run check:edge-functions`.
   Run `npm run check:db-function-sources`, `npm run check:db-function-catalog`, and the full `npm run test:db` on an isolated stack.
   Run `npx vitest run tests/release-edge-compatibility.test.ts` and the deployed-to-release soak against the actual migration range.
   Save the migration plan and its attestation before production work.
2. Confirm the project's scoped production link and inspect `supabase migration list --linked`.
   Run `supabase db push --linked --dry-run` from the frozen release checkout.
   Confirm applied history matches the 431-version production baseline.
   The dry-run must show exactly 117 versions: the 63 pending main migrations, then the 54 unpublished migrations.
   Verify their names and version order against the approved plan.
   Use the workflow's approved `supabase/predeploy/` index preparation and migration-plan attestation checks.
   Then run `supabase db push --linked --yes` under production approval.
3. Before Edge deployment, recheck `supabase migration list --linked` against the attested plan.
   Verify the deployed frontend and old Edge still pass the workflow's post-migration current-release readiness checks.
   Verify `add_free_agent_atomic` accepts optional `p_to_ir` and `p_to_taxi`.
   Verify `waiver_claims.to_ir`, `waiver_claims.to_taxi`, `player_game_stats.is_home`, and `get_visible_player_totals` exist.
   Before Edge deployment, `sync-player-injuries` dispatch can return HTTP 404 harmlessly.
   This absence must cause no alert, rapid retry, or failed readiness check.
   Check the deployed client's hint topics and inventory details remain accepted.
   Stop if any check fails; keep the old frontend and Edge on the compatible migrated database.
4. Stamp the approved Edge artifact with `PANCAKE_RELEASE_SHA=<reviewed-sha> node scripts/stamp-edge-release-provenance.mjs`.
   Run `supabase functions deploy --project-ref "$SUPABASE_PROJECT_REF"` under production approval.
   Include the new `sync-player-injuries` function in the stamped artifact and deployment.
   Verify `/health` reports the reviewed commit and Edge digest.
   Run the workflow's current-frontend/new-Edge and candidate-frontend/new-Edge readiness checks before merging.
   Confirm one straight-to-taxi add and one straight-to-IR add.
   Check waiver claims, visible player totals, trades, and notification delivery.
   Verify `sync-player-injuries` records its own run and refreshes injuries without a full player sync.
   If Edge checks fail, restore the recorded old Edge artifact and repeat current-release readiness checks.
   `supabase functions deploy` does not delete functions absent from the restored artifact.
   The new `sync-player-injuries` function can stay deployed after rollback or be absent; both states are safe.
5. Merge only after the database and Edge checks pass.
   Let Vercel publish the frontend, then verify its release marker and the final production readiness checks.
   If frontend checks fail, restore the recorded old frontend and Edge artifacts; keep the compatible database migrations.

The following 54 unpublished migrations follow the 63 pending main migrations in version order.
Compare this list with the frozen checkout and approved plan before deployment.

- `20261024100001_straight_to_ir.sql`
- `20261024100002_live_player_season_totals.sql`
- `20261024100003_reconciliation_writes_and_poll_gate.sql`
- `20261024100004_visible_player_totals.sql`
- `20261024100005_activity_feed_hide_trade_block.sql`
- `20261025000030_trade_counterparty.sql`
- `20261025000031_trade_offer_page_refs.sql`
- `20261025000040_rookie_member_activation.sql`
- `20261025000041_activity_change_hints.sql`
- `20261025000050_avoid_unchanged_score_finalization.sql`
- `20261025000051_bound_edge_response_reconciliation.sql`
- `20261025000052_ignore_game_progress_hints.sql`
- `20261025000053_remove_stale_schedule_descriptions.sql`
- `20261025000054_reduce_inventory_hint_drain.sql`
- `20261025000055_drop_retired_server_functions.sql`
- `20261025000070_scoring_bonus_settings.sql`
- `20261025000071_waiver_run_order.sql`
- `20261025000072_trade_waiver_drop_settlement.sql`
- `20261025000073_trade_activity_privacy.sql`
- `20261025000074_rookie_acquisition_guard.sql`
- `20261025000075_playoff_seed_rates.sql`
- `20261025000076_cancelled_waiver_privacy.sql`
- `20261025000077_seed_correction_window.sql`
- `20261025000090_waiver_hold_before_roster_capacity.sql`
- `20261025000091_rookie_drop_activation.sql`
- `20261025000092_queue_waiver_notifications.sql`
- `20261025000093_drop_retired_push_functions.sql`
- `20261025000094_roster_claim_and_activity_corrections.sql`
- `20261026000010_accept_server_generated_schedule.sql`
- `20261026000011_restore_boundary_correction_window.sql`
- `20261026000012_dispatch_drafting_boundary.sql`
- `20261026000013_scope_visible_activity_hints.sql`
- `20261026000014_drop_unused_score_decision.sql`
- `20261026000015_store_game_team_side.sql`
- `20261026000030_faab_trade_reservations.sql`
- `20261026000031_season_offer_and_priority_rules.sql`
- `20261026000032_trade_offer_roster_validation.sql`
- `20261026000033_roster_claim_retention.sql`
- `20261026000034_trade_notification_privacy.sql`
- `20261026000035_waiver_run_clearance.sql`
- `20261026000060_team_name_validation.sql`
- `20261026000061_remove_unused_database_objects.sql`
- `20261026000080_retire_expo_push_storage.sql`
- `20261026000100_keep_deployed_edge_push_compatibility.sql`
- `20261026000101_order_rookie_activation_locks.sql`
- `20261026000200_merge_main_function_bodies.sql`
- `20261026000300_server_release_corrections.sql`
- `20261026000400_server_release_followups.sql`
- `20261026000500_server_release_repairs.sql`
- `20261026000700_taxi_and_server_rules.sql`
- `20261026000800_player_import_injury_and_retired_enums.sql`
- `20261026000900_roster_and_dispatch_repairs.sql`
- `20261026000901_activity_feed_public_rows.sql`
- `20261026001000_remove_e2e_fixture_players.sql`

## Acquisition contract

Existing positional RPC calls remain valid because new arguments have defaults.
The server removes ambiguous older overloads.

| RPC | Added arguments |
| --- | --- |
| `add_free_agent_atomic` | `p_to_ir boolean DEFAULT false`, then `p_to_taxi boolean DEFAULT false` |
| `create_waiver_claim_atomic` | `p_to_ir boolean DEFAULT false`, then `p_to_taxi boolean DEFAULT false` |
| `edit_waiver_claim_atomic` | `p_to_ir boolean DEFAULT NULL`, then `p_to_taxi boolean DEFAULT NULL` |

Waiver API bodies accept `toIr` and `toTaxi`.
Omitted create values mean false; omitted edit values preserve the stored destination.
`waiver_claims.to_ir` and `waiver_claims.to_taxi` are non-null and default to false.
An add cannot request both destinations.
Straight-to-IR and straight-to-taxi adds remain available without a league opt-in.
Both permit eligible acquisitions after tipoff because these players do not score.
They still consume a weekly add.
IR requires an Out or IR designation, an open slot, and an allowed season state.
Taxi requires eligibility, an open unreserved slot, remaining tenure, and no prior exit from that team's taxi.

Every league uses `years_exp = 0` or fewer than 65 career NBA regular-season games.
A non-rookie needs a known count to enter taxi.
An unknown count never makes an existing taxi player illegal.
The retained `leagues.taxi_rule` column supports rollback reads; settings ignore submitted rule values.
The phone computes Rookie and Taxi display tags from stored server values.
The server decides whether an acquisition is legal.

At award time, the worker checks the destination again.
An unavailable IR or taxi destination falls back to active space and any applicable planned drop.
A claim fails with a clear reason when neither destination fits.
The worker processes older due runs before newer claims within each league.
Activity and winning-claim notifications name the taxi destination.

| Code | Meaning |
| --- | --- |
| `PA001` | Weekly add limit reached |
| `PA002` | Player remains on waivers |
| `PA003` | Active roster capacity exceeded |
| `PA005` | An existing IR player is ineligible |
| `PA006` | Requested player cannot enter IR |
| `PA007` | IR capacity exhausted |
| `PA009` | An existing taxi player is ineligible |

The shared roster guard reports named IR and taxi problems and one team-level active overflow problem.
It blocks adds, new claims, claim edits that add, sent offers, and acceptance by the illegal team.
Pending claims fail while that roster remains illegal.
The acquisition guard leaves lineup moves, activations, drops, and cancellations available.
Existing lineup capacity, reservation, and game-lock checks still apply.
[Roster lifecycle](../docs/roster-lifecycle.md) owns the complete rule contract.

## Trades and activity

Trading opens in offseason, drafting, active, and playoffs.
Setup and the startup auction close trading.
Commissioner deadlines and roster rules still apply.
The public activity feed omits pending offers, counters, edits, expirations, and trade-block changes.
Completed trades remain visible with their participants.
Private offer state remains in the Trades screen.

At the opening-night cutoff, completed rookie drafts do not wait for every team to trim its roster.
The server places the newest eligible drafted rookies into available taxi slots first.
The league activates even when some teams still exceed their active limit.
Those teams must fix their rosters before restricted acquisitions or trades.

## Data and compatibility

`search_players` appends `career_regular_season_games integer` without changing earlier result columns.
`get_visible_player_totals` supplies bounded visible-player statistics.
`player_game_stats.is_home` preserves the stored game side.
Live player changes use the existing `score` topic with null scopes and details.
The minute throttle keeps pending changes for its next flush.
No new `player_stats` topic or scoped `activity` inventory detail ships in this release.

Incremental season totals preserve per-game scoring and existing average read shapes.
DNP lines and non-regular-season games do not contribute to regular-season averages.
The projection reader skips started or finished games without changing its result columns.
Retired search-cache refresh routines remain callable and return without rebuilding data.
Reconciliation skips unchanged writes, and the live gate returns while a current lease exists.

`sync-player-injuries` refreshes injuries each quarter hour on game days, from 11:00 ET through the last scheduled tipoff.
It receives `{}` and records its own `sync_runs` outcome.
`sync-players` keeps its daily full refresh; it has no injury-only mode.
Player imports preserve stored injuries when metadata omits `injury_status`; explicit null clears them.
[Source monitoring](../docs/source-monitoring.md) owns provider schedules and recovery.

The cleanup migrations remove unused tiebreak storage and server routines after replacing their callers.
They retain objects used by the deployed Edge and frontend through the rollback window.
The fixture cleanup removes only the E2E player identities defined by its migration.
Review that migration's predicate with the approved plan before deployment.

## Verification

Run the ordered upgrade and compatibility checks against the reviewed migration range.
Use [verification](../docs/verification.md) for setup and [migration history](../docs/production-migration-history.md) for attestation rules.
Regenerate final attestations only after all migration changes are integrated.
Previous run counts do not certify this candidate.

## Next release

Drop `leagues.taxi_rule` after the deployed client and its rollback retire.
Every league now uses NBA rookies or fewer than 65 career regular-season games.

Add the dedicated `player_stats` topic and scoped `activity` inventory resource only after the deployed receiver accepts them.
Keep this release's Players tab subscribed to `score` until that change ships.
Drop `standings.waiver_priority` after old Edge writers and their rollback window retire.
Live waiver order already uses `waiver_priorities`.


Keep `weekly_lineups`, `waiver_claims`, and `waiver_wire_log` in `supabase_realtime` through this release.
The deployed Roster screen and its rollback still subscribe to these tables.
Remove them only after the new client ships and its rollback window closes.

```sql
ALTER PUBLICATION supabase_realtime DROP TABLE
  public.weekly_lineups, public.waiver_claims, public.waiver_wire_log;
ALTER TABLE public.weekly_lineups REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_claims REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_wire_log REPLICA IDENTITY DEFAULT;
```

The merged migration range requires new release attestations before deployment.
The published attestations retain the recorded production baseline.

Keep the Expo objects while the deployed Edge release or its rollback can use them.
The client cannot update `profiles.push_token`; the service role keeps access.
The database phase also keeps receipt tickets and their current leases.

First ship an Edge release that removes Expo delivery, receipt polling, and legacy storage access.
Settle pending tickets and close its rollback window.
Then add this follow-up migration:
`20261027000000_remove_legacy_expo_after_edge.sql`.
This SQL stays outside `supabase/migrations` until that release.
It requeues pending tickets, replaces the queue routines, and then removes the legacy objects.
Remove their canonical sources and catalog entries, then regenerate types for that release.

```sql
DROP TRIGGER IF EXISTS normalize_legacy_push_token_write ON public.profiles;
DROP FUNCTION IF EXISTS private.normalize_legacy_push_token_write();

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  WITH deleted AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NOT NULL
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL AND queued.suppressed_at IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at=clock_timestamp(),suppression_reason='league_deleted',
    claimed_at=NULL,claim_token=NULL FROM deleted WHERE queued.id=deleted.id;
  WITH stale AS (
    SELECT queued.id FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.available_at <= clock_timestamp()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND private.notif_is_stale(queued.event_type,queued.data)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = clock_timestamp(), suppression_reason = 'stale',
    claimed_at = NULL, claim_token = NULL FROM stale WHERE queued.id = stale.id;
  WITH disabled AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id = queued.member_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND NOT private.notif_preference_enabled(member.user_id,queued.event_type,queued.category)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL FROM disabled WHERE queued.id = disabled.id;
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
       AND queued.suppressed_at IS NULL
       AND EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
         WHERE member.id=queued.member_id AND league.deleted_at IS NULL)
       AND NOT private.notif_is_stale(queued.event_type,queued.data)
       AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
       AND private.notif_preference_enabled((SELECT member.user_id FROM public.league_members member WHERE member.id = queued.member_id),queued.event_type,queued.category)
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.created_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id, queued.title,
       queued.body, queued.data || jsonb_build_object('notificationEvent',queued.event_type,'outboxId',queued.id) AS data, queued.category
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id, claimed.title,
    claimed.body, claimed.data, claimed.category
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET dead_lettered_at = now(),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_process_trades_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= now()
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
  END IF;
END;
$$;

UPDATE public.notification_outbox
   SET claimed_at = NULL, claim_token = NULL, available_at = now()
 WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND expo_ticket_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_notification_outbox_ticket_atomic(uuid, uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.claim_notification_receipts_atomic(integer, integer);
DROP FUNCTION IF EXISTS public.defer_notification_receipt_state_atomic(uuid, uuid, text, integer, boolean);
DROP FUNCTION IF EXISTS public.register_push_token_atomic(uuid, text, text);
DROP FUNCTION IF EXISTS public.revoke_push_token_atomic(text, text);
DROP FUNCTION IF EXISTS public.clear_push_token_for_user_atomic(uuid, text);

DROP INDEX IF EXISTS public.notification_outbox_receipt_queue;
DROP INDEX IF EXISTS public.notification_outbox_expo_ticket_unique;
DROP INDEX IF EXISTS public.profiles_push_token_lookup;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_pair,
  DROP CONSTRAINT IF EXISTS profiles_push_token_revocation_hash_format;

ALTER TABLE public.profiles
  DROP COLUMN push_token,
  DROP COLUMN push_token_revocation_hash;

ALTER TABLE public.notification_outbox
  DROP COLUMN expo_ticket_id,
  DROP COLUMN push_token,
  DROP COLUMN ticketed_at,
  DROP COLUMN receipt_attempt_count;
```
