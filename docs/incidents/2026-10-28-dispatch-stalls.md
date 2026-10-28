# Database stalls on 2026-10-28

The exported evidence does not identify a definitive outage cause.
It shows database stalls before the reported 01:45 UTC redeploy.
No production service is contacted during this investigation.

## Exported evidence

The supplied cron export contains 99 runs from 01:30 through 02:58 UTC.
Eight failed entries start before 01:45 UTC.

| Result | Runs | Mean duration | Maximum duration |
| --- | ---: | ---: | ---: |
| Job startup timeout | 28 | 65.042 s | 491.42 s |
| Statement timeout | 15 | 98.097 s | 146.49 s |
| Success | 56 | 1.114 s | 38.39 s |

The approximately ten-second errors say `job startup timeout`.
They do not identify a statement running inside `dispatch_work`.
The statement-timeout messages end at `CONTEXT`, before the nested statement.
The statistics export contains completed top-level calls and no execution timestamps.
It cannot identify which nested statement runs during a failed dispatch.

Cron's own metadata insertion reaches 66.031 seconds.
Its metadata update reaches 73.952 seconds.
A small invocation summary query reaches 63.840 seconds.
These independent stalls support a wider database resource or scheduling problem.
They do not prove its underlying cause.
The connection and wait snapshot at 02:50 cannot exclude earlier waits.

The work export contains eight selected rows, all after 02:50.
The invocation export contains four selected rows from 02:55.
They do not establish an empty queue throughout the incident.
Work timestamps use transaction time, and failed dispatch transactions roll back their work records.
A missing completion record therefore does not prove that no inline statement runs.

Full PostgreSQL error context, wait samples, and resource metrics remain necessary for attribution.
Do not call the redeploy, retention, queue locks, or an inline kind the confirmed production cause.

## Reproduced queue waits

A private stack restores the supplied public, private and Auth table data into the current schema.
Removed tables and storage metadata stay outside this workload.
The restored database contains 245,097 player-stat rows and 7,360 weekly lineups.

The first reproduction holds a lease update on an existing active work row.
This statement waits during its uniqueness check:

```sql
INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
ON CONFLICT DO NOTHING RETURNING id;
```

The old enqueue cancels at the 250 ms lock deadline.
The new enqueue finds existing active work through the existing index and returns in 9.34 ms.
The unique index remains the final guard against concurrent duplicate inserts.

The second reproduction holds a conflicting table lock on `net.http_request_queue`.
It queues 24 different payloads and holds four running worker rows.
The blocked nested statement is the queue insertion inside `net.http_post`.
This simulates queue insertion contention, rather than slow remote HTTP responses.
A response backlog alone does not imply an insertion lock.

The previous dispatcher repeats claims until its outer five-second timeout cancels the transaction at 5,015 ms.
The new dispatcher claims one item at a time, starts at most eight, and stops starting items after two seconds.
It commits recorded item failures and leaves the remaining items pending.
The same contention fixture completes in 2.07 seconds.
An overlapping call returns in 9.34 ms through the existing advisory lock.
No new lease starts for work that the dispatcher cannot execute.

These controlled reproductions prove two possible failure paths and their repairs.
The production exports do not prove that either path causes the outage.

## Concurrent load

All 28 worker kinds are due, including retention.
The admission limit starts at most eight active workers.
Seven actual Edge handlers start together after one inline item.
The harness queues 2,000 local HTTP requests and holds running lease rows for three seconds.
Twenty clients read the screen views while a separate local account signs in.
External providers and notification transports are blocked.
Handlers share one Deno process; separate cloud cold starts are outside this test.

| Measurement | Result |
| --- | ---: |
| View reads | 3,552 |
| Failed view reads | 0 |
| Read p95 | 23 ms |
| Initial dispatch | 107 ms |
| Four additional dispatch calls | 36–47 ms |
| Contention regression checks | 11 pass |

A score worker fails during the deliberately conflicting lease updates.
The harness proves read and dispatch latency under this load, rather than successful provider ingestion.
The private result does not reproduce the wider production resource stall.

## Replay startup

The runtime adds `sslmode=disable` to its database URL before the clock target check.
That check forbids all query strings, so a fresh replay fails before it starts.
The runtime now preserves the validated URL.
The local SQL client receives `PGSSLMODE=disable` separately.
The regression executes runtime startup through the same target guard.
It fails on the old source and passes after repair.

## Verification

The full unit suite passes 3,853 tests, with zero failures and 33 skips.
All 306 season tests pass, including the new runtime startup regression.
All 13 quality stages pass.
The private database passes 70 targeted checks.
The new contention recipe contributes 11 of those checks.
Both old queue behaviors fail their new regression controls.
Migration and security attestations cover 596 migrations through `20261114000300`.
The database function catalog and generated database types match the fresh database.
The private stack is stopped after verification.
Backup copies and start secrets are removed.

The reset applies every migration before a local Storage DNS health check fails.
Direct database checks then verify the fresh schema, migration fingerprints, catalog, and types.
This setup error occurs after the successful load test and does not establish a production cause.
