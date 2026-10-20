# Historical season simulator

The simulator exercises local production dispatch, Edge handlers, database rules, and authenticated user actions.
Its generated evidence establishes coverage.
Earlier reports and fixture facts do not establish a new run's result.
See the [command guide](../scripts/season-sim/README.md).

## Inputs

| Class | Inputs |
| --- | --- |
| REAL-RAW | NBA final boxes and play-by-play, ESPN JSON, published 2026–27 NBA schedule |
| REAL-DERIVED | Historical schedule, roster observations, injury selection, historical live snapshots |
| SYNTHETIC | Users, actions, invented prospects, next-season boxes and live snapshots |

Manifests record source URL, retrieval time, status, byte count, and SHA-256.
Reads verify decompressed bytes.
Next-season mappings retain the historical source game and target schedule hash.
Known source exceptions remain pinned; they never exempt official final equality.

## Checks

| Area | Independent evidence |
| --- | --- |
| Live matchups | Authenticated client score read versus stored stats and locked starters; private Realtime subscription |
| Weekly scoring | Every expected result finalizes; standings rebuild from completed regular results |
| Playoffs | Independent seeds, bracket advancement, grace periods, multi-week point totals |
| Champion | Finalized final, independent winner, authenticated bracket read before rollover |
| Deadline | Commissioner setting, completed early trade, blocked late proposal and acceptance, pending offer state |
| Rookie draft | Independent prior standings order, snake reversal, traded owner, production expiry path |
| Picks | Far-year allocation, unused rounds, retained traded ownership |
| Next season | Published schedule, synthetic scoring, fresh standings, retained season-one history |

An implemented check is not a measured pass.
Reports retain missing acceptance work and distinguish assertion failures from execution failures.
The report adds continuation wording only when a continuation occurs.
It never imports old defect fixes as new evidence.

## Trigger fidelity

Production cron gates drive automatic outcomes.
Production has no daily direct `sync-stats` or `sync-scores` job.
The replay removes those morning and season-end overrides.
A missing champion or rollover must remain a failure.
A commissioner matchup-generation request is an authenticated setup action.
The installer records the actual migrated cron catalog before disabling jobs.

Current replay sampling follows gate completion.
Sampling every internal worker tick, complete ancillary cron inputs, and restored segment proofs remain acceptance requirements.
Published segment durations stay unknown until measured.
A short or resumed diagnostic run never counts as a fresh full replay.
