# Work queue model

`WorkQueue.tla` models one dispatcher minute at a time: lease expiry, the stalled live-poll release, the running cap, claim order, the forecast-input slot gate and the loop limit in `public.dispatch_work`. `extract.mjs` reads those rules from the SQL sources, so the model checks the code, not a copy of it.

Run it with `npm run check:formal:work-queue`. Add `--install` to download TLC, or `--run=<name>` to run one entry from `coverage.json`.

## Properties

| Invariant                | Meaning                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `LivePollFirst`          | A due live-poll is claimed in the same dispatch when a worker slot is free.                                      |
| `StalledLivePollRetries` | A live-poll invocation that never started or stopped renewing is claimed again within `StallBound` dispatches.   |
| `BackgroundKindsRun`     | No due kind except live-poll and matchup-forecasts goes unclaimed for more than `FairBound` dispatches in a row. |
| `NoItemRunsTwice`        | A lost invocation that wakes late cannot act on the retry of its item.                                           |

## Replays

Each historical run reads the claim rules at a past revision and must fail the invariant that its fix restored. Every `rev` must be reachable from `main`, because CI clones only branches and tags. When the exact pre-fix commit is not on `main`, a replay reads the nearest `main` revision and sets `mutate` to the rules that commit had. `unfenced-finish` removes the lease-token fence and must fail `NoItemRunsTwice`. A run that stops failing means the model no longer sees that mistake.

## Environment

The model keeps the adversary to what the queue promises to survive. Up to `MaxHolders` long workers hold slots. Live-poll and matchup-forecasts are due every minute. One burst of urgent edge and SQL work can arrive. Forecast inputs keep arriving. Matchup-forecasts has real work only after forecast inputs finish. Advisory-lock skips, the 2-second budget and the degraded scheduler levels are outside the model.

## When the check fails

If the current run fails, the claim rules break a property. The message names the rule to restore. If the covered files changed, confirm that `extract.mjs` still reads every rule that `work_claim` and `dispatch_work` apply, update the model when a new rule appears, then set `syncCommit` in `coverage.json` to the new commit.
