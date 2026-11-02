# Screen reads after 2.11

The private mini project is `pt4bafablesr`. Its ports are 642xx.
The database uses one CPU and 1 GiB during measurement.
The backup has 2,618 players, 241 roster entries, and 245,097 game rows.
Backup hashes are checked before startup. Copied backups are deleted after restoration.
Cron is disabled. External database HTTP is blocked. Delivery destinations are cleared.

The runner reuses `screen-view-costs.mjs` and `unpartition-player-stats.mjs`.
Each sample opens a new connection. The warm sample follows five priming calls.
EXPLAIN includes planning and execution time and shared hit and read buffers.
Node timing is disabled. Nested plans are captured separately.
Five rounds alternate the version order across three managers.
The p95 of five samples is their maximum.

The first baseline is the actual 2.10.2 migration set from `892b6bca`.
The stack then migrates to `1e696f25`.
The restored backup has no OneNumberHoops values or published trade-value cache rows.
The offline source fixture populates 450 rankings and 18 pick values.
The production analyzer recomputes saved v5 estimates and publishes the three open trades locally.
No source fetch runs.

The final comparison substitutes the affected release definitions in rollback transactions.
It uses the same migrated data and published v5 results for all versions.
The 2.10.2 substitution also restores its ownership response and asset-lock reader.
Earlier measurements before source import remain in the lane evidence.
The forty-card fixture copies participants, assets, quotes, and published cache rows.
A separate forty-player block fixture exercises nonempty fallback joins.
All synthetic rows roll back after each sample.
Fixture tables are vacuumed and analyzed before each synthetic sample.
This removes dead rows left by earlier rollback fixtures.
Earlier samples without this preparation remain in the evidence directory.

The kept changes are bounded fantasy-average lookups, one read per distinct card player, one extraction of each cached trade JSON,
and screen reads under the function owner after the existing caller check.
The generic-plan experiment was discarded because its buffer counts increased.
Changed functions are `view_players`, `view_trades`, `view_trade_block`, `view_player`,
`view_home`, `get_trade_cards`, and `view_roster` in `public`.
No model arithmetic or stored values change in the migration.

Run only on the assigned mini checkout:

```sh
export PATH=$HOME/pancake-local/tools:$PATH
export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock
node tests/db/screens-after-211-stack.mjs setup
node tests/db/screens-after-211.mjs --inventory
node tests/db/screens-after-211.mjs --capture --label=2102
node tests/db/screens-after-211.mjs --trace --label=2102
node tests/db/screens-after-211-stack.mjs migrate 1e696f25
node tests/db/screens-after-211.mjs --recompute
node tests/db/screens-after-211.mjs --compare --populated
node tests/db/screens-after-211.mjs --parity --candidate --label=final
node tests/db/screens-after-211.mjs --trace --candidate --populated --label=final
node tests/db/screens-after-211-stack.mjs migrate
node tests/db/screens-after-211.mjs --capture --variants --label=installed
node tests/db/screens-after-211.mjs --report
node tests/db/screens-after-211-verify.mjs
node tests/db/screens-after-211-stack.mjs stop
```

Setup expects `schema.sql`, `data.sql`, and their SHA-256 map in `../backup/manifest.json`.
Apply it after comparison and parity for installed measurements.
Raw evidence stays in `../screens-after-211-evidence`.

## Results

Every comparison case passes the 150 ms fresh limit and the matching 2.10.2 warm-buffer bound.
Each cell is the largest p95 across three managers. The dense page uses its proposing manager.
The buffer columns show the largest warm hit-plus-read count.

| Function / case | 2.10.2 fresh / warm ms | 2.11 fresh / warm ms | Fixed fresh / warm ms | Warm buffers 2.10.2 / 2.11 / fixed |
| --- | ---: | ---: | ---: | ---: |
| view_players | 40.73 / 17.77 | 38.72 / 17.81 | 37.51 / 16.33 | 1985 / 1985 / 1153 |
| view_trades | 17.50 / 6.79 | 17.72 / 6.93 | 15.25 / 4.25 | 606 / 628 / 498 |
| view_trade_block | 11.26 / 2.57 | 11.16 / 2.18 | 11.15 / 1.55 | 446 / 444 / 380 |
| view_player | 27.21 / 6.45 | 28.20 / 8.83 | 25.60 / 6.81 | 762 / 769 / 686 |
| view_home | 13.76 / 4.75 | 15.26 / 4.78 | 12.81 / 3.95 | 694 / 694 / 633 |
| view_trade_block populated-block | 35.18 / 27.13 | 38.24 / 28.44 | 12.18 / 2.41 | 4011 / 4009 / 822 |
| view_trades populated-block | 41.50 / 31.77 | 47.72 / 30.53 | 17.09 / 5.06 | 4152 / 4173 / 916 |
| view_trades 40-cards | 27.24 / 17.36 | 29.96 / 18.50 | 18.61 / 8.27 | 3105 / 3120 / 778 |

The installed migration has 970 samples across 97 variants.
Its largest fresh p95 is 59.02 ms. Every comparable installed warm-buffer count also passes.
No definitions are substituted in installed samples.
The interleaved comparison adds 660 samples.

| Installed default | Fresh p95 ms | Warm p95 ms | Warm buffers |
| --- | ---: | ---: | ---: |
| view_players | 50.76 | 20.65 | 1126 |
| view_trades | 16.14 | 4.40 | 460 |
| view_trade_block | 20.32 | 2.27 | 345 |
| view_player | 35.32 | 6.67 | 637 |
| view_home | 18.73 | 3.81 | 603 |

## Statement findings

These are separate instrumented warm calls for the first manager.
They include child execution. Parent and child values must not be added.

| Statement | 2.10.2 buffers | 2.11 buffers | Fixed buffers |
| --- | ---: | ---: | ---: |
| Player-search aggregation | 1259 | 1259 | 435 |
| Populated block aggregation | 3607 | 3607 | 485 |
| Player projection helper | 199 | 199 | 197 |
| Home lineup assignments | 214 | 214 | 214 |
| Forty-card batch aggregation | 2574 | 2589 | 657 |

The v5 cache join adds reads and repeatedly extracts toasted JSON fields.
Repeated assets also reread the same player, current average, historical totals, and ranking.
The old forty-card plan performs 240 player and average lookups and 160 ranking lookups.
The fixed materialized player set performs those reads once per distinct player.
Fallback fantasy joins are bounded to one player before entering the union view.
Players response version 023 only changes the returned ownership map.
Its search statement does not grow in this replay.
The offers change does not reproduce a large asset-lock read increase.

The production multi-second latencies and 20,000-buffer trade reads are not reproduced.
The backup predates the imported values, published analyses, and populated block.
The extra fixtures exercise those paths without claiming an exact production action mix.
The saved-model recompute does not run during screen reads.
No production contention, production latency gain, or CPU-headroom gain is claimed.

## Verification

All 109 serialized JSON cases match across three managers.
The cases include live and off-day dates, availability filters, player sections, populated blocks,
dense cards, legacy models, null analysis fields, and scalar cache payloads.
Nine corrupted-response controls each reject one changed response.
The new authorization recipe passes 45 checks.
Eleven SQL recipes pass, with 378 counted assertions and two recipes without counters.
The existing timing recipe also rejects a deliberate delayed read.
Canonical sources and the live function catalog match.
Release attestations regenerate from the private database through migration 039.

The old live-screen fixture used an Eastern date in a Pacific league.
It fails with the original 2.11 home function during the midnight gap.
The fixture now uses the league date and passes all 63 checks.

The private stack is stopped. Its config is restored. Copied backups are removed.
No production service, push, pull request, deployment, or CI run was used.

Local unit validation remains blocked.
The shared `node_modules` symlink points to a missing dependency directory.
The pinned Vitest 4.1.9 reaches collection but cannot resolve the Expo base tsconfig.
All 528 files fail collection. No unit test executes.
The direct TypeScript command resolves global 4.6.4 rather than locked 5.9.2.
Pinned lint and type validation remain unverified.
The shared symlink is untouched. No dependencies are installed.
Restore the shared project dependencies, then run the full Vitest suite once and the quality commands.
Database measurements and SQL checks do not need to be repeated unless SQL changes.

Verification receipt (external evidence) pins the tested migration hash.
Measurements (external evidence) retain every summarized case and target check.
