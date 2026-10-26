# Release database contract

## Release order for this release

Database, then Edge, then merge the frontend.
Production currently stops at migration `20261027000203`.
Apply `20261028000100_recheck_final_stats.sql` after that baseline.
It allows overdue final-game checks without another active game.
It also queues one seven-day correction window per Eastern date, starting after 06:20.
The existing fenced worker processes that window one game at a time.
The migration preserves game statistics, player identities, accounts, and league settings.
Deploy the reviewed `sync-players` artifact to retain its placeholder filter.
The current frontend and older Edge artifacts remain compatible with the added scheduler function.

Verify the migration on the private stack with `npm run test:db:stats-corrections`.
The regression fails before the migration when a stale final game is the only pending work.
It checks the retry window, daily idempotence, completed jobs, DST, and client execution grants.
If the background correction job must be stopped, unschedule `daily-stat-corrections`.
Keep the schema upgrade and do not revert corrected game data.

## Previous release order

Database, then Edge, then merge the frontend.
Production currently stops at migration `20261026001000`.
That baseline includes every migration through `20261026001000_remove_e2e_fixture_players.sql`.
Keep every published migration unchanged.
Apply these follow-up migrations after that baseline, in version order:

- `20261027000100_three_future_draft_classes.sql`
- `20261027000101_remove_unreferenced_distant_picks.sql`
- `20261027000200_player_identity_matching.sql`
- `20261027000201_player_career_counter.sql`
- `20261027000202_player_source_coverage.sql`
- `20261027000203_preserve_explicit_career_writes.sql`

The counter migration replaces its earlier unpublished rehearsal version.
Rebuild the rehearsal from the production baseline before applying this revised file.

The first migration limits new pick assets to three future draft classes and corrects pick years in trade-expiry messages.
It also rejects trades containing retained picks beyond that window.
The second removes unused, unreferenced picks beyond the third future class.
It discovers every foreign key to `draft_picks` and preserves referenced picks, activity references, used picks, and rookie draft assignments.
For OFFICIAL LEAGUE at season 2027, the expected cleanup removes 42 picks from seasons 2031 and 2032.
The remaining future classes are seasons 2028–2030, displayed as draft years 2027–2029.

The March backfill reads one capped player page and matches names exactly before inserting missing players.
Its lookup ignores team aliases and misses hyphen/space variants.
The June importer removes `sleeper_id` from name-matched updates, leaving those rows unlinked.
Its name key removes hyphens but preserves spaces, so `Jones-Garcia` and `Jones Garcia` differ.
The old automatic merge only handles a shared NBA or Sleeper ID.
These paths leave separate source rows without a shared ID to trigger a merge.
Historical deployment logs are unavailable here, so they cannot identify which missed read created every individual duplicate.

The player migrations link new sources by a unique normalized name and NBA team.
Names use letters only; team aliases include `SA` → `SAS`.
Ambiguous names retain the review path, and conflicting source IDs never merge.
The supplied production pattern merges seven rows into six NBA-backed survivors:

| Survivor | Merged source rows | Team |
| --- | --- | --- |
| David Jones Garcia | Sleeper David Jones-Garcia; legacy sportsdata David Jones-Garcia | SAS, including legacy SA |
| Joan Beringer | Sleeper Joan Beringer | MIN |
| Nic Claxton | Sleeper Nic Claxton | CHI |
| Taelon Peter | Sleeper Taelon Peter | IND |
| Trevon Scott | Sleeper Trevon Scott | BKN |
| Will Richard | Sleeper Will Richard | GSW |

The NBA row survives; every compatible provider ID and dependent reference moves through `merge_players`.
The migration skips any group with conflicting provider IDs.
Below 65, career totals use a fixed base plus regular-season appearances after the base season.
An appearance has positive minutes or any positive counting statistic, regardless of its DNP flag.
The base normally comes from ESPN per-season GP through the previous season.
Later seasons come from our boxes; ESPN's current-season lag does not remove the latest appearance.

| Existing state | Migration result | Next lookup |
| --- | --- | --- |
| Non-null count below 65 | Preserve the count exactly; leave base unset | One ESPN completed-season fetch |
| Non-null count at least 65 | Preserve the count exactly; leave base unset | None |
| NULL count; rookie with no earlier appearance | Base 0 through the previous season | None |
| NULL count; every completed NBA season covered | Provisional base 0 through 2020 | One successful ESPN fetch only while below 65 |
| NULL count; at least 65 covered appearances | Base 0 through 2020; total is a safe lower bound | None |
| Other NULL count | Remain unknown | ESPN first; retry failures after at least seven days |

Covered completed seasons must equal `years_exp`.
A current-season appearance adds one to the number of observed seasons, not to completed experience.
Any appearance before coverage prevents the complete-coverage fallback.
A late first stored season never proves a late NBA debut.
ESPN, rookie, and threshold bases are never fetched again.
Coverage bases below 65 need one successful ESPN lookup because historical boxes have gaps.
No player with at least 65 stored games enters the lookup queue, regardless of base source.
The database claim checks that limit again before any external request.
Existing counts remain stored; exact totals above 65 do not affect taxi eligibility.
Transactional recounts continue, but cannot lower a count once it reaches 65.
Explicit count writes, including NULL, remain valid for the deployed Edge and fixture setup.
The final migration limits the career guard to base changes and preserves timestamp-only updates.
It changes no stored counts when applied.
The lookup replaces coverage with the completed-season ESPN base and recounts later local appearances.
Unavailable ESPN data leaves coverage unchanged and permits another attempt after at least seven days.
Any base lookup that would lower the stored total is rejected, preserving the count for a later attempt.
The worker limits each run to 300 players, 16 concurrent jobs, and a 90-second start budget.
External work for one player has an eight-second deadline.
Earlier import work also reduces the remaining lookup budget.
The worker starts no new lookup after 110 seconds of the complete daily sync.
Players on an NBA team run first, then those closest to 65 stored games.
Unknown counts follow known counts within each group; the oldest attempts break ties.
Deferred work remains due for the next daily run.
Run `supabase/sql/player-data-audit.sql` against approved candidate data to inspect base sources, queue counts, and season coverage.
The NBA-team queue equals unknown unbased players plus unbased counts below 65 plus coverage counts below 65.
The aggregate of 541 known ESPN counts does not show how many are below 65.

The existing Edge and frontend remain compatible throughout the database phase and after rollback.
Stored years and existing RPC arguments, results, and permissions stay compatible.
The player table gains nullable base, cutoff, source, and lookup-time fields.
Regenerate the final release and database security attestations after all follow-up migrations are integrated.
Do not reuse the previous release's approved migration range.
The reserved `20261027000000` legacy-push cleanup is separate from this pick release.

1. Freeze the reviewed commit and record the deployed frontend and Edge artifacts.
2. Run the focused database recipes and the generated-source, catalog, type, and Edge checks on an isolated stack.
3. Verify the approved migration plan against the deployed baseline, then apply it through the release workflow.
4. Check the deployed frontend and Edge against the migrated database before replacing either artifact.
5. Deploy Edge, verify compatibility, then deploy the frontend.
6. If deployment fails, restore the old frontend and Edge while keeping the compatible migrated database.

The focused pick recipes are:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/pick-window.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/pick-window-cleanup.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/pick-draft-year.sql
PANCAKE_PICK_WINDOW_DB_TESTS=1 npx vitest run tests/e2e/pick-window-harness.test.ts
```

The harness recipe also requires the isolated stack's `E2E_SUPABASE_URL`, `E2E_PANCAKE_SUPABASE_SECRET_KEY`, and `E2E_SUPABASE_PUBLISHABLE_KEY`.

## Connected players and current rosters

The source-coverage migration keeps existing import and injury RPC contracts working during rollback.
It adds service-only source-link and full-roster-cycle functions plus private roster evidence tables.
Current ESPN and NBA rosters drive membership; Sleeper supplies IDs and missing metadata.
The injury feed can link an ESPN player-card ID before applying its status.
Sleeper projections link IDs before the same run writes projections.
Existing non-null source IDs, experience, and positions remain intact.
Ambiguous names, team mismatches, and conflicting IDs stay unresolved for review.

The reported 45 missing ESPN IDs, 91 missing Sleeper IDs, 19 missing NBA IDs,
30 missing experience values, and one missing position can fill when their source records match uniquely.
The eight players missing both ESPN and NBA IDs can link independently from either roster.
These counts can overlap; they do not establish that all 692 team labels remain current.
A player absent from both complete rosters for a full daily cycle loses the stale team label.
Partial rosters, one-source omissions, recent box evidence, and stale refreshes keep the existing hold protections.
An incomplete NBA roster records `rosterRefreshSkipped` without failing an otherwise successful sync.
Provider fetch or identity-write failures still fail the sync and report their cause.
Unassigned-player history remains available through the existing list behavior.
The audit lists unresolved current players and pending absence holds after each complete cycle.

Injury dispatch also runs hourly outside the existing game-day quarter-hour window, from 08:00 through 02:00 ET.
Deploy the database first, then the updated Edge functions; the old Edge remains compatible with the additive schema.

## Player data verification

Use the private stack described in `docs/verification.md`.
These recipes need no new package commands:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-identity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-merges.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-career.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-base-regressions.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-base.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-legacy-writes.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-coverage-upgrade.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-career-queue.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-appearances.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-regular-season.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-source-connectivity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-source-box.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-roster-cycle.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-injury-hours.sql
npm run test:db:player-data
```

The fixtures reproduce Mario Hezonja, Skal Labissiere, and Guerschon Yabusele returning after gaps.
Returning veterans and existing counts of at least 65 remain unchanged without an ESPN request.
The fixtures also model incomplete Cam Christie boxes, ESPN's one-game lag at 64 games, and incorrect DNP flags.
Fetched totals use completed ESPN seasons plus all later local appearances.
A coverage fixture moves from 64 stored games to 69 after its ESPN lookup.
The recipes also prove weekly retry, nondecreasing upgrades, and no repeat lookup after success.
They verify that 65-plus players never queue, including a player reaching 65 while waiting for another attempt.
A valid career total also checks season-history completeness, with one game of tolerance for source lag.
The migration test starts before the counter migration and proves that seven known counts never decrease.
It also checks rookie, complete-coverage, threshold, and unknown fallbacks.
Run that separate transition recipe before the final full reset:

```sh
supabase db reset --local --version 20261027000200
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/player-data-migration.sql
supabase db reset --local
```

The transition recipe rolls back its fixtures and migration.
The existing regular-season filter recognizes NBA `002` games and excludes other NBA `00` types.
Preseason, playoffs, play-in, and Cup finals contribute zero.
Zero-minute appearances with a positive counting statistic contribute one.
Legacy Basketball Reference imports keep the existing schedule filter.

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
