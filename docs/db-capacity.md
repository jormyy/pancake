# Database capacity

## Measured boundary

The current evidence is a synthetic local game-night replay, not a production capacity test.
The fixture has ten teams, about 2,600 players, and 246,000 `player_game_stats` rows.
It remains production-sized; no historical data is removed to improve the result.
The latest three-run training median database size is 267,054,227 bytes.
The largest training sample is 267,062,419 bytes, or 53.41% of the 500 MB Free allowance.
The held-out database is 265,628,819 bytes.

Database size is an accepted exception to the half-allowance target.
Official statistics and results have no automatic expiry.
An explicit historical-data policy or a larger plan is needed before continued growth reaches the allowance.
The replay cannot establish how many months of production growth remain.

## Growth and retention

Median allocation increases by 868,352 bytes during the four-minute training window.
Settlement adds 147,456 bytes after that window.
These values include reusable pages and maintenance allocation; do not extrapolate them as permanent row growth.
No current production growth rate is measured.

| Data | Retention | Bound |
| --- | --- | --- |
| Successful cron history | 6 hours | 512 eligible rows per hourly cleanup |
| Failed cron and orphan checks | 24 hours | Same cleanup |
| Successful sync history | 1 day, plus newest outcome per function | 4,096 rows per hourly cleanup |
| Failed sync history | 30 days, plus newest outcome | Same cleanup |
| Private `l1:` broadcasts | 1 day | 4,096 rows per hourly cleanup |
| Scheduler transitions | 7 days | 512 rows per hourly cleanup |
| Official game statistics and results | No automatic expiry | Product history remains durable |

Cleanup preserves active work, required failure evidence, and protected newest outcomes.
It respects pause and skips locked rows.
Backlogs can outlast their nominal age windows because deletion is bounded.
Deleted space becomes reusable after maintenance; file size need not shrink.
Other managed Realtime topics retain provider policy.

## Memory and connections

The lab caps its database cgroup at 192 MiB with swap available.
The selected runtime settings are 32 MB shared buffers and a PostgREST pool of two.
These are separate from the fixture size and Supavisor pool.
Training measures a median 122,384,384-byte anonymous-memory peak and 71,770,112-byte shared-memory peak.
Component peaks can occur at different times; do not sum them as one observed peak.
The maximum measured container memory is 201,228,288 bytes.

Training records 19.24 new database sessions per minute.
Six local health probes and about one cron start per minute explain part of that rate.
The remaining 12.24 includes Auth sessions for necessary screen reads.
The PostgREST data pool remains connected; short Auth sessions caused the earlier excess churn.
See [hosted settings and lab results](live-scores.md).

## Capture a growth window

Use the same server, source, fixture, and request mix at both ends.
Capture after warmup and again after scheduled retention.
Record elapsed wall time separately from simulated time.

```sh
node scripts/db-health/index.mjs --output ../evidence/day-zero.json
node scripts/db-health/index.mjs --output ../evidence/day-two.json
node scripts/db-health/index.mjs --compare ../evidence/day-zero.json ../evidence/day-two.json 180
```

The last argument is an example projection horizon, not measured season duration.
An accelerated replay must supply its actual simulated interval to the comparison.
The command rejects another database, another server start, or reversed times.
Keep negative allocation changes visible.
Measure table, index, TOAST, WAL, and retained operational history separately.
Allow additional storage for WAL, backups, and maintenance.

## Decision limits

The [Free-plan budget](live-scores.md#free-plan-budget) projects ten phones for 180 hours per month.
It does not establish a supported production user count or billing outcome.
Hosted settings, actual compressed egress, and sustained provider behavior require rollout read-back.
Older multi-gigabyte memory recommendations and restored-backup forecasts do not describe this architecture.
Use current measured rows per completed game and retained history before choosing a storage plan.
