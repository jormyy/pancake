# Bounded replay acceptance

A resumed replay proves only the dates and actions it measures.
It does not replace a fresh, uninterrupted full-season run.
Use the [simulator guide](season-simulator.md) for supported replay modes.

A fresh official late start requires no saved checkpoint.
Its summary marks earlier scenario windows `not measured: late start`.
All remaining checks must pass for `lateStart.passed` to become true.
`fullAcceptance` stays false.
The launcher stores the result in `evidence/late-season-check.json`.

## Required evidence

| Area | Required proof |
| --- | --- |
| Source identity | Commit, harness hashes, fixture manifest, and restored snapshot hashes |
| Recovery | Original failure retained; recovery starts from the recorded state |
| Settled history | Earlier stats, lineups, roster history, and results stay unchanged |
| Scoring | Authenticated scores match an independent oracle for every measured matchup |
| Delivery | Real subscription events match stored results within the observed window |
| Drafts and trades | Authenticated actions match ownership, pick consumption, and transaction history |
| Rollover | Champion, roster continuity, balances, schedule, and rookie activation reconcile |
| Cutoff | No stats or finalized games appear beyond the declared end date |
| Negative controls | Corrupted inputs fail the same assertions used for acceptance |

Keep original failures, source receipts, and recovery evidence outside tracked documentation.
Record the first and last measured date in the generated report.
Do not replay settled dates merely to replace a failed receipt.
A later successful window cannot certify a lost earlier Realtime stream.

## Limits

List missing source inputs and unmeasured product areas in the report.
Keep source quality separate from in-app arithmetic and ranking checks.
Absent player appearances cannot establish scoring coverage for those players.
Synthetic next-season boxes do not establish real next-season source coverage.
Browser emulation does not establish installed-iPhone behavior.
Outbox rows do not prove push-provider delivery or device display.

Mutation reports must retain survivors and invalid mutations separately.
A survivor outside the fixture's path remains a coverage gap.
A passing recovery control applies only to the failure it exercises.
Use generated reports for counts and outcomes; do not copy them into this guide.
