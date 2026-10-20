# Historical season simulator

The simulator replays NBA activity through real local dispatch, Edge handlers, database rules, and authenticated manager actions.
It exercises scoring, lineups, locks, waivers, trades, IR, taxi, playoffs, rollover, and the rookie draft.
Use the [setup and command guide](../scripts/season-sim/README.md).

## Input classes

| Class | Inputs |
| --- | --- |
| REAL-RAW | NBA final boxes and play-by-play; ESPN date scoreboards and summaries |
| REAL-DERIVED | Schedule, historical roster bootstrap, injury/news selection, and live boxes |
| SYNTHETIC | Users, manager actions, invented prospects, unavailable-career responses, and fault overlays |

Collection records source URL, retrieval time, status, byte count, and SHA-256.
Reads verify decompressed bytes. Raw finals retain the provider shape.
The configured season runs from October 21, 2025 through April 12, 2026.
Historical announcement times are unavailable. Recaps substitute for general news.
Roster bootstrap can use later debut observations. Historical career totals remain unknown.
Synthetic prospects test taxi and rookie flows without inventing historical career totals.

`scripts/season-sim/known-discrepancies.json` pins accepted live counting-stat differences.
Derived minutes and plus-minus retain source limits.
These limits never exempt final equality.
The [reviewed identity correction](../supabase/functions/_shared/playerIdentityCorrections.md) preserves the canonical player and history.

## Dispatch and clock

The driver calls production dispatch SQL in timeline order. pg_net reaches the local Deno router.
Handlers use real PostgREST, authorization, leases, receipts, and write locks.
Database and Edge business time share a monotonic anchor that stops at the next planned event.
Read-only checks pause business time. Native work deadlines keep real wall time.
The isolated installer replaces local clock functions and audits affected business-time references.
Production receives no clock seam.

Fault overlays inject stale delivery, duplicates, source failures, missing data, transport failures, and overlapping dispatch.
Recovery must use production handlers and database guards.
Independent checks compare final fields, player points, lineup totals, matchup outcomes, and retained history.
Next-day and end-of-season repeats check recovery and idempotence.

## Acceptance

Fixture collection alone does not prove a replay.
A short or resumed diagnostic run does not prove a fresh full season.
Inspect the generated final report for completed dates, final equality, faults, actions, lifecycle outcomes, and invariant failures.
Keep reports outside tracked documentation and regenerate them for the source under review.
Local replay does not measure hosted startup, quotas, scheduler overlap, or physical iPhone behavior.
