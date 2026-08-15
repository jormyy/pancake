# Soak-harness forced-red audit (AC-24)

A green soak is only evidence if its assertions can go red. Each major
assertion family below was audited by breaking the code it guards, running the
smallest soak slice that exercises it, and confirming the run FAILS — then
restoring the code and confirming green. Runs use the local stack
(`supabase start` + `supabase functions serve` + seeded league).

Status legend: RED-PROVEN = mutation produced a failing run; ALWAYS-GREEN =
assertion could not be made to fail (reported per AC-24); PENDING = not yet run.

| # | assertion family | guarded code | mutation | result |
|---|---|---|---|---|
| 1 | busy-offseason activity (AC-23) | trade completion via process-trades | trade processor batch limit forced to 0 | RED-PROVEN (scenario fails at multi-team propose: two-team trade never completed) |
| 2 | season reset carryover (D.SEA.6) | advance_season_atomic roster carry-over | CREATE OR REPLACE without the roster_players carry insert | RED-PROVEN ("carried roster missing ...") |
| 3 | weekly scoring finalization (D.SEA.2) | finalize_score_week_atomic winner writes | finalize_score_week_atomic returns before any writes | RED-PROVEN ("matchup did not finalize", "winner_member_id=<null>") |
| 4 | waiver processing (D.SEA.2) | process_due_waiver_claims_atomic | edge batch loop forced to zero batches | RED-PROVEN (all claims stay pending) |
| 5 | playoff bracket generation (D.SEA.4) | generate_playoff_bracket_atomic | CREATE OR REPLACE that returns without inserting matchups | RED-PROVEN ("created 0 quarterfinals") |
| 6 | rookie draft auto-pick (D.SEA.5) | auto_pick_snake_pick_atomic best-available order | ORDER BY nba_draft_number DESC | RED-PROVEN (wrong best-available pick detected) |
| 7 | boundary invariants (D.0/I2) | draft_picks ownership resolution | point one pick's current_owner_id at a foreign member | RED-PROVEN (I2 owner-does-not-resolve) |

## Notes / always-green findings

- Every audited assertion family went red under its mutation and returned to
  green after restore (logs in the session scratchpad `audit/` directory;
  restores re-applied the canonical `supabase/sql/functions/by-name` sources).
- No always-green scenario was found among the audited families. The failure
  mode Wave 8 actually uncovered was the opposite: three release scenarios
  (auction bid validation, waiver-push capture, realtime auction bid) had been
  **always-red** since the July 8-9 waiver/auction migrations — the weekly
  release-soak workflow evidently had not produced a green run since — plus a
  ~50/50 flake in the waiver-processing reseed assertion. All four are fixed
  in this branch.
- Runtime note: the release soak requires Node 22+ (global WebSocket for the
  realtime slice) and, on macOS Docker, `host.docker.internal` fake-upstream
  URLs (both now tolerated by the harness).
