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
| `roster_transactions`, `waiver_wire_log`, succeeded `waiver_claims`, `league_activity` | history | Never deleted. A succeeded claim keeps its drop player. A player merge re-points the surviving identity and closes an open waiver entry whose player is rostered under it. |
| `weekly_add_counts`, `faab_balances`, `waiver_priorities`, `standings` | member/season state | Not player-linked; unchanged. |
| `nominations`, `bids`, `snake_draft_picks` | draft history | Unchanged. |
| Client caches (trade block, player support, roster) | derived | Refreshed on focus, and on realtime changes each screen watches: the players tab `roster_players`; the roster tab `roster_players` and `draft_picks`; the trades screen the trade tables, `trade_block_items` and `draft_picks` (`lib/trades-realtime.ts`). |

## Paths that change ownership

| Path | Entry point | Roster mutation |
| --- | --- | --- |
| Direct drop | `drop_player_atomic` (client RPC), `drop_and_add_free_agent_atomic`, `activate_roster_player_with_overflow_atomic` | `DELETE` |
| Waiver drop | `process_next_waiver_claim_atomic` via `private.release_roster_player_to_waivers` | `DELETE` |
| Trade | `complete_accepted_trade_atomic` | `UPDATE member_id` |
| IR / taxi | `toggle_ir_atomic`, `toggle_taxi_atomic`, `clear_ineligible_taxi_players` | `UPDATE is_on_ir / is_on_taxi` |
| Player identity merge | `merge_players` (service role) | `UPDATE player_id` and duplicate `DELETE` |
| Draft reset, commissioner or service-role maintenance, E2E fixtures | `reset_draft_atomic`, direct SQL | `DELETE` |
| Pick moves | `complete_accepted_trade_atomic` (owner), `private.make_snake_pick_atomic_internal` and `process_expired_snake_pick(s)_atomic` (`is_used`), `reset_draft_atomic` (`is_used` back to false) | `UPDATE draft_picks.current_owner_id / is_used` |

## Enforcement

Two `AFTER` row triggers own the cleanup, so every path above is covered without
per-RPC code:

- `sync_roster_linked_state` on `roster_players` (`DELETE`, `UPDATE OF member_id,
  is_on_ir, is_on_taxi`) removes the listing, clears future unlocked lineups, nulls
  stale pending waiver drops, and expires pending offers that included the player.
  It only acts when no active current-season row is left for that member and player,
  so removing an old-season row never touches live state.
- `sync_pick_linked_state` on `draft_picks` (`UPDATE OF current_owner_id, is_used`)
  removes pick listings and expires pending offers for the pick.

Both run inside the mutating transaction, so a partial failure rolls everything
back, a retry has nothing left to clean, and concurrent requests serialize on the
row and advisory locks the mutation already holds. `add_trade_block_item_atomic`
locks the roster row `FOR SHARE`, so a listing cannot be created for a player whose
drop is in flight. A player merge (`merge_players`) moves the listings, lineups,
pending drops and offers of a member who already holds the surviving player on the
active roster before it deletes their duplicate row, so the trigger finds nothing of
theirs under the old identity; every other member's state is cleared by the trigger
or moves with their re-pointed roster row. The merge then closes an open waiver
entry whose player is rostered under the surviving identity.

`private.is_reserved_trade_asset` is the single accepted-trade reservation check and
`private.assert_not_reserved_trade_asset` its single rejection (SQLSTATE `PA004`, one
sentence): the roster and pick guards raise it, trade acceptance raises it for an
asset reserved by another trade, and waiver-drop validation returns the same sentence.
The drop and IR/taxi RPCs rely on the guards rather than checking again.
`start_rookie_draft_atomic` refuses to start while a pick of the draft class is
reserved, so a slot never stalls on a pick the trade still owns.
`private.lineup_game_started` is the one "this slot's game has started" rule, read by
the lineup RPCs, the lifecycle cleanup, and the DB suites (the lineup RPCs now also
treat a recorded `started_at` as started; before they read only the feed status and
the tip-off time). `private.ineligible_ir_player_names` is the one list of IR players
who no longer qualify: a free-agent add raises it as SQLSTATE `PA005` and the app
opens the IR resolution flow, and the waiver processor records it as the claim's
failure reason.
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
drifted (stale listings, stale pending drops, pending offers whose asset was gone);
`20260827000010` backfilled stale future lineup slots the same way.

## Waiver window

A dropped player's entry clears 48 hours after the drop, but the run that
processes claims is daily (3:00 AM ET). Until the run processes the entry the
player stays on waivers: `prevent_uncleared_waiver_free_agent_add` rejects a
free-agent add of any uncleared entry (SQLSTATE `PA002`, so waiver priority never
loses to the fastest add; the add RPC itself never reads the wire), and
`create_waiver_claim_atomic` accepts a claim on any uncleared entry. Expired
uncleared entries stay hidden from league-wide reads, so a client may show such a
player as a free agent; the rejection carries `PA002` and every pickup entry point
then offers the claim flow instead of a dead end.
`npm run test:db:waiver-window` runs `tests/db/waiver-clearing-window.sql`, which
covers the add rejection, the claim inside the window, the rejected claim on a
processed entry, and the next run picking the claim up.

`npm run test:db:three-season` runs `tests/db/three-season-simulation.sql`: two
leagues with different settings play three seasons through the real RPCs (an
auction start with full-budget bids and open slots, free agency under weekly limits
with commissioner overrides and week resets, drops, FAAB and rolling claims, trades
with member and commissioner vetoes and expiry, trade-block cleanup, lineups, IR and
taxi moves, rookie snake drafts with commissioner picks and pause/resume, a draft
that waits for a reserved pick, retries of the start, bid, add, drop, claim, accept,
pick, activation and rollover calls, three rollovers) and checks the invariants,
growing history, and frozen past seasons after every phase. Removing an enforcement trigger or the
weekly-limit check turns it red.

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
reset instant; `current_add_week_number` is a projection of it for the counters.

Feedback:

- The rejection reads `Weekly add limit reached (7/7 adds used this week). Adds reset
  Mon, Nov 2 at 12:00 AM ET.` and is raised with SQLSTATE `PA001`. The code reaches
  the app as `code` (through supabase-js for direct RPC calls, through the Edge API
  for routed ones) and the app classifies on it, so a stale client, or a client
  whose last slot was consumed elsewhere, still learns the next eligible time from
  the server. A waiver claim that fails the same check at processing time records the
  same message as its failure reason. `private.weekly_add_limit_message` and
  `private.weekly_add_limit_reset_label` are the only renderings of that sentence
  and of the reset boundary.
- `get_member_transaction_state` returns `add_limit_resets_at`, `add_limit_message`
  (the same sentence, present while the week's adds are used up) and
  `add_limit_resets_label`. Free-agent adds (the players tab add button and header
  line, the player page Add) read them through `lib/pickup.ts` and the
  `useAddLimitGate` hook inside `useQuickAdd` and mark the action blocked through
  `accessibilityState` with the reason as its hint (it stays pressable so a tap
  explains); the drop-to-add picker and the IR-resolution continuation gate on tap
  only; claims run the same IR gate as adds and then open the claim modal, which owns
  the add-limit gate with fresh state. Every one explains the block with that
  sentence, so the pre-check and the rejection say the same thing, and
  `reportPickupError` in `lib/pickup.ts` turns the server's rejection into the same
  explanation.
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
service-role delete, and stale-client removals. On the schema before the migration
the suite fails at its first scenario.

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
`SET oracle.steps`. The seed fixes the walk's choices, but new rows still take
`gen_random_uuid()` ids, so a failing seed reproduces in distribution rather than
step for step; rerun it a few times. The oracle found the pick-reservation gap fixed in
`20260827000003_reserve_accepted_trade_picks.sql`; removing any of the three
enforcement triggers turns it red within a few dozen steps.
