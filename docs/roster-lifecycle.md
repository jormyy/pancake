# Roster lifecycle invariants

What must be true about every record tied to roster ownership, which paths change
ownership, and where the database enforces it.

## Relationship map

A roster row is `roster_players (league, season, member, player, is_on_ir, is_on_taxi)`.
Every other roster-linked record falls into one of three classes.

| Record | Class | Rule when the player leaves the roster or becomes inactive |
| --- | --- | --- |
| `trade_block_items` (player) | live state | Removed. A listing exists only while the member has that player active (not IR, not taxi) in the current season. |
| `trade_block_items` (pick) | live state | Removed when the pick changes owner or is used in a draft. |
| `weekly_lineups` (future, unlocked dates) | live state | Cleared for that member and player. Rows for started or finished games stay for scoring. |
| `waiver_claims` pending `drop_player_id` | live state | Set to NULL when the drop player leaves the roster; the claim stays pending and the processor applies the normal "roster full and no drop" rule. IR/taxi moves of a pending drop player are still rejected. |
| `trades` pending with the lost asset | live state | Expired with `completion_failure_reason` and a `trade_expired` activity row. IR/taxi moves do not expire offers; acceptance already requires an active roster. |
| `trades` accepted | reservation | Deletes and IR/taxi moves of reserved players are rejected; a reserved pick cannot be used in a draft or change owner until the trade completes or expires. |
| `roster_transactions`, `waiver_wire_log`, succeeded `waiver_claims`, `league_activity` | history | Never touched. A succeeded claim keeps its drop player. |
| `weekly_add_counts`, `faab_balances`, `waiver_priorities`, `standings` | member/season state | Not player-linked; unchanged. |
| `nominations`, `bids`, `snake_draft_picks` | draft history | Unchanged. |
| Client caches (trade block, player support, roster) | derived | Refreshed on focus and on realtime changes to `roster_players`, `trade_block_items`, `draft_picks`, `trades`. |

## Paths that change ownership

| Path | Entry point | Roster mutation |
| --- | --- | --- |
| Direct drop | `drop_player_atomic` (client RPC), `drop_and_add_free_agent_atomic`, `activate_roster_player_with_overflow_atomic` | `DELETE` |
| Waiver drop | `process_next_waiver_claim_atomic` via `private.release_roster_player_to_waivers` | `DELETE` |
| Trade | `complete_accepted_trade_atomic` | `UPDATE member_id` |
| IR / taxi | `toggle_ir_atomic`, `toggle_taxi_atomic`, `clear_ineligible_taxi_players` | `UPDATE is_on_ir / is_on_taxi` |
| Player identity merge | `merge_players` (service role) | `UPDATE player_id` and duplicate `DELETE` |
| Draft reset, commissioner or service-role maintenance, E2E fixtures | `reset_draft_atomic`, direct SQL | `DELETE` |
| Pick moves | `complete_accepted_trade_atomic`, `make_snake_pick_atomic`, `reseed_rookie_draft_picks_atomic` | `UPDATE draft_picks.current_owner_id / is_used` |

## Enforcement

Two `AFTER` row triggers own the cleanup, so every path above is covered without
per-RPC code:

- `sync_roster_linked_state` on `roster_players` (`DELETE`, `UPDATE OF member_id,
  is_on_ir, is_on_taxi`) removes the listing, clears future unlocked lineups, nulls
  stale pending waiver drops, and expires pending offers that included the player.
  It only acts when no active current-season row is left for that member and player,
  so removing an old-season row never touches live state.
- `sync_trade_block_on_pick_change` on `draft_picks` (`UPDATE OF current_owner_id,
  is_used`) removes pick listings and expires pending offers for the pick.

Both run inside the mutating transaction, so a partial failure rolls everything
back, a retry has nothing left to clean, and concurrent requests serialize on the
row and advisory locks the mutation already holds. `add_trade_block_item_atomic`
locks the roster row `FOR SHARE`, so a listing cannot be created for a player whose
drop is in flight. A player merge (`merge_players`) re-points listings to the
surviving player next to the other tables it re-points.

`private.is_reserved_trade_asset` is the single accepted-trade reservation check
used by the roster and pick guards, the drop and IR/taxi RPCs, waiver-drop
validation, and trade acceptance (which excludes the trade being accepted).
`private.pick_left_owner` is the one rule for "this pick left its owner" that the
pick guard and the pick-listing sync share. Trade completion and pending-offer
expiry mark their transaction through
`private.begin_trade_lifecycle_write` / `end_trade_lifecycle_write`;
`prevent_trade_status_client_writes` and `prevent_accepted_trade_pick_change` honour
that mark, so an expiry that runs inside an authenticated drop still goes through
while direct client writes to `trades.status` stay rejected.

The waiver processor marks a claim `succeeded` before it releases the drop player, so
the trigger's "null stale pending drops" step never rewrites the claim being
processed.

Migration `20260827000001_roster_lifecycle_invariants.sql` introduced the triggers,
removed the older per-RPC cleanup calls, and backfilled rows that had already
drifted (stale listings, stale pending drops, pending offers whose asset was gone).

## Weekly add limits

A league's `weekly_add_limit` caps free-agent adds and processed waiver claims per
add week. The server is authoritative on every path: `add_free_agent_atomic`,
`drop_and_add_free_agent_atomic`, `create_waiver_claim_atomic` (at submission) and
the waiver processor (at success) all call `private.assert_weekly_add_available`.

Add weeks follow `season_weeks` in Eastern Time (`private.add_week_timezone`): the
count resets at 12:00 AM ET the day after the scheduled week ends. Before the first
scheduled week the count belongs to that week. Past the last scheduled week (playoffs,
offseason) the count rolls every seven days from the day after that week; a new
season with no schedule yet keeps the same cadence anchored on the prior season.
`private.current_add_week` owns that rule and returns both the week number and the
reset instant; `current_add_week_number` and `weekly_add_limit_resets_at` are
projections of it.

Feedback:

- The rejection reads `Weekly add limit reached (7/7 adds used this week). Adds reset
  Mon, Nov 2 at 12:00 AM ET.` and is raised with SQLSTATE `PA001`; the Edge API
  forwards that code and the app classifies on it, so a stale client, or a client
  whose last slot was consumed elsewhere, still learns the next eligible time from
  the server. A waiver claim that fails the same check at processing time records the
  same message as its failure reason.
- `get_member_transaction_state` returns `add_limit_resets_at` and `add_week_timezone`.
  Every pickup entry point (players tab add button and header line, player page Add
  and Claim, the waiver-claim modal, the drop-to-add picker and the IR-resolution
  continuation) reads them through `lib/add-limit.ts` and the `useAddLimitGate`
  hook, the one client owner of "explain the block before the request, report the
  server's rejection after it". The action renders in a disabled state with the
  reason as its accessibility hint and explains the block on tap with the reset
  shown in ET and in the viewer's local zone when they differ.
- A cached count whose week already ended is treated as available again on the client;
  the server opens the new week on the next request.
- A commissioner override (`commissioner_override_weekly_add_count_atomic`) changes the
  count only; the reset instant is unchanged.

`npm run test:db:weekly-add-limit` runs `tests/db/weekly-add-limit-boundaries.sql`:
inside a week, the last day of a week, the first day of a week, a gap before the next
week, the seven-day cadence past the schedule (two buckets), an unscheduled new
season, no schedule at all, and the rejection message and member state agreeing on the
instant.

## Testing

`npm run test:db:roster-lifecycle` runs `tests/db/roster-lifecycle-invariants.sql`
against the local stack. It exercises a direct drop and its retry, IR and taxi moves,
a processed waiver drop (history kept), a completed player and pick trade, a pending
offer whose player was dropped, a pending claim whose drop player left, a used pick
and a pick that changed owner, a player merge, an old-season row removal, a direct
service-role delete, stale-client removals, and the global "no stale listing"
invariant. On the schema before the migration the suite fails at its first scenario.

`npm run test:db:roster-oracle` runs `tests/db/roster-lifecycle-oracle.sql`, a seeded
state-machine oracle. It seeds two leagues (one user owns a team in both), then walks
a random sequence of operations as managers, the commissioner, and the service role:
listings, drops (including retries of removed rows and other users' rows), adds,
drop-and-add, IR and taxi moves, trade proposals, acceptance, completion, rejection
and withdrawal, waiver claims and processing, commissioner overrides, direct
service-role deletes, pick consumption and ownership changes, player merges,
cross-league attempts, lineup edits, and exact replays of the previous statement.
After every step it checks the table above as executable invariants (listings,
future lineups, pending drops, pending and accepted offers, roster flags and league
scoping, history growth and terminal-record immutability, add counts, waiver
windows) and that every operation expected to be rejected was rejected. Accept,
reject and withdraw run as the service role, as the API calls them. A rejection the
engine raised rather than a `RAISE` in a function (a missing column, a raw constraint
violation, a bad call) fails the run, and so does any operation family that expected
success at least once and never got it, so a silently broken function or a walk that
never reaches a path cannot pass as green. Rotate the seed with `ORACLE_SEED=<n>` (default 1) and the length with
`SET oracle.steps`. The oracle found the pick-reservation gap fixed in
`20260827000003_reserve_accepted_trade_picks.sql`; removing any of the three
enforcement triggers turns it red within a few dozen steps.
