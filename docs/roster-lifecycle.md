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
| `trades` accepted | reservation | Unchanged: deletes and status moves of reserved players are rejected. |
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
  player_id, is_on_ir, is_on_taxi`) removes the listing, clears future unlocked
  lineups, nulls stale pending waiver drops, expires pending offers that included the
  player, and re-points a listing when a player merge changes `player_id`. It only
  acts when no active current-season row is left for that member and player, so
  removing an old-season row never touches live state.
- `sync_trade_block_on_pick_change` on `draft_picks` (`UPDATE OF current_owner_id,
  is_used`) removes pick listings and expires pending offers for the pick.

Both run inside the mutating transaction, so a partial failure rolls everything
back, a retry has nothing left to clean, and concurrent requests serialize on the
row and advisory locks the mutation already holds. `add_trade_block_item_atomic`
locks the roster row `FOR SHARE`, so a listing cannot be created for a player whose
drop is in flight.

Pending-offer expiry inside an authenticated transaction sets the transaction-local
`app.trade_lifecycle_server_write` flag that `prevent_trade_status_client_writes`
honours; direct client writes to `trades.status` stay rejected.

The waiver processor marks a claim `succeeded` before it releases the drop player, so
the trigger's "null stale pending drops" step never rewrites the claim being
processed.

Migration `20260827000001_roster_lifecycle_invariants.sql` introduced the triggers,
removed the older per-RPC cleanup calls, and backfilled rows that had already
drifted (stale listings, stale pending drops, pending offers whose asset was gone).

## Testing

`npm run test:db:roster-lifecycle` runs `tests/db/roster-lifecycle-invariants.sql`
against the local stack. It exercises a direct drop and its retry, IR and taxi moves,
a processed waiver drop (history kept), a completed player and pick trade, a pending
offer whose player was dropped, a pending claim whose drop player left, a used pick
and a pick that changed owner, a player merge, an old-season row removal, a direct
service-role delete, stale-client removals, and the global "no stale listing"
invariant. On the schema before the migration the suite fails at its first scenario.
