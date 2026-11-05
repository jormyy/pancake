# Pre-tipoff failure handling

Pending offers alone do not lock lineup slot changes.
Ownership, started-game, IR, taxi, and accepted-trade guards still apply.
Migration `20261214005500_pre_tipoff_member_failures.sql` also isolates failures within a lineup dispatch.
Apply it before deploying `lineup-optimizer`.
The previous worker remains compatible with the additive schema.

A member's roster failure does not fail healthy members in the same batch.
`public.record_pre_tipoff_lineup_failure` checks the member, revision, token, and lease.
It stores at most 4,000 error characters.
The first terminal receipt wins.
The same revision skips a recorded failure; changed inputs permit another attempt.
Lease loss and receipt-write failures remain retryable.
Scheduled and manual optimizer paths keep their existing behavior.

Run `tests/db/pre-tipoff-member-failures.sql` and `tests/db/trade-locks-drop-only.sql` on an isolated stack.
Run `tests/e2e/pre-tipoff-live-concurrency-db.mjs` for overlap and retry checks.
See [daily lineups](pre-tipoff-lineups.md) for the complete operating rules.
