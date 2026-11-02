# Database IO model

## What is measured

A row write, WAL byte, buffer access, storage operation, and memory refault measure different work.
An unchanged row can still acquire locks or produce WAL.
Cached reads can still use backend memory and CPU.
Nested statement times overlap; do not sum them as independent costs.
PostgreSQL pages are 8 KiB, while the lab reports kernel memory counters in their native units.

The database cgroup's anonymous refault rate is the lab's primary memory-pressure measure.
VM-wide swap counters include other containers and remain diagnostics.
The kernel provides no normal per-cgroup swap-out counter in this environment.
Read the [lab results](live-scores.md#lab-results) before attributing a gain to any individual change.

## Work and frequency

| Path | Normal rate or trigger | Cost to include |
| --- | --- | --- |
| Public live snapshots | Visible phones every 30 seconds; shared 30-second cache | Provider requests, public bytes, function CPU, cache-region misses |
| Database live import | Status transitions, finals, corrections, 30-minute checkpoints | Changed stat rows, revisions, triggers, totals, WAL |
| Database fallback | 30-second live ticks, none on idle slates | Per-game saves and unchanged-input checks; retained for rollback |
| Home views | Opening, relevant committed changes, reconnect, ten-minute public recovery | Auth sessions, SQL view, internal transfer, compressed phone response |
| Dispatcher | Every minute | One cron backend, queue reads, bounded SQL chunks, leased Edge starts |
| Saved screen publication | At most every two minutes during games | Only changed cache content and relevant version hints |
| Matchup win odds | Every 30 minutes during games and at matchup end | Input preparation, forecast computation, publication |
| Standings and season totals | Weekly matchup end; game final or correction, respectively | Changed aggregates and views |
| Realtime | Committed actions and official changes | One send plus receiving clients; no live-only tick message |
| Retention and vacuum | Bounded hourly cleanup and table thresholds | Dead tuples, reusable pages, visibility and index maintenance |

A tick's work scales with games and changed lines in database mode.
Public mode removes routine per-tick database saves; it does not weaken final certification.
Final imports still resolve player identity and reject ambiguous games.
Status, final, and correction writes retain score revisions, permission checks, and relevant broadcasts.

## Remaining write costs

The dispatcher admits at most four active workers and 32 items within a two-second budget.
SQL screen and forecast-input chunks share its existing connection.
A work item's start, heartbeat, completion, retries, and failure evidence are real writes.
A new authenticated action also writes its idempotency receipt and product outcome.
Auth sessions remain required for private screen requests.

`emit_league_change`, score input revisions, totals, league versions, and notification markers remain on relevant official changes.
Normal live checkpoints suppress live-only broadcasts but retain version history.
Batched hints retain their private scopes and events.
Content hashes and exact comparisons prevent unchanged screen and analysis rewrites.

No player-stat index is an exact duplicate.
Player/date/season access paths, the global identity guard, and replica identity remain.
Only the checked duplicate game-time index is removed.
Score revision triggers skip irrelevant updates but retain meaningful changes, inserts, and deletes.
Player-stat storage uses fillfactor 90 and earlier vacuum/analyze thresholds.
These settings affect future maintenance; they do not immediately compact existing pages.

## Lab cost summary

Four-minute training medians compare the previous and current public architecture.
Database API calls fall from 343 to 165; Home reads fall from 90 to 14.
New sessions fall from 83.46 to 19.24 per minute.
Excluding six local health probes and cron leaves 12.24 sessions per minute.
WAL remains about 300 KB per minute because real actions, finals, and background work remain.
Broadcast sends fall from 26 to 16; phone deliveries fall from 240 to 142.
These measurements do not assign causal refault pages to a function or trigger.

The highest remaining costs are official stat imports, authorized actions, forecast delivery, queue dispatch, and managed Realtime.
Investigate each with per-function statement totals, connection clients, memory peaks, and WAL deltas.
Sum duplicate query IDs by function; preserve measurement windows and report real saved work.
Compare under fixed source, fixture, runtime settings, and quality gates.
The [replay lab](../scripts/bench/game-night/README.md) rejects no-op runs and broken finals.

## Maintenance

Daily statistics inspect freshness before ANALYZE and skip fresh tables.
The independent statistics connection does not extend the dispatch transaction.
Bounded hourly history cleanup preserves current work and required failures.
See [scheduler operations](operations-scheduler.md) and [capacity](db-capacity.md).
Diagnostics, logs, and generated rankings belong outside the repository.
