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
| 1 | busy-offseason activity (AC-23) | trade completion via process-trades | stub `/e2e/process-trades` handling (process-trades edge no-ops) | PENDING |
| 2 | season reset carryover (D.SEA.6) | advance_season_atomic roster carry-over | CREATE OR REPLACE without the roster_players carry insert | PENDING |
| 3 | weekly scoring finalization (D.SEA.2) | finalize_score_week_atomic winner writes | CREATE OR REPLACE that skips matchup winner updates | PENDING |
| 4 | waiver processing (D.SEA.2) | process_due_waiver_claims_atomic | edge PROCESS batch loop forced to zero batches | PENDING |
| 5 | playoff bracket generation (D.SEA.4) | generate_playoff_bracket_atomic | CREATE OR REPLACE that returns without inserting matchups | PENDING |
| 6 | rookie draft auto-pick (D.SEA.5) | auto_pick_snake_pick_atomic best-available order | ORDER BY nba_draft_number DESC | PENDING |
| 7 | boundary invariants (D.0/I2) | draft_picks ownership resolution | point one pick's current_owner_id at a foreign member | PENDING |

## Notes / always-green findings

(filled in as the audit runs)
