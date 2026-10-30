# L1 Realtime

The candidate replaces 16 table watches with private database Broadcast.
Keep the legacy publication until old clients reload and their subscriptions drain.
Apply `20261214004000_live_broadcast.sql`, then `20261214004010_coalesce_live_hints.sql`, before the frontend.
No Edge function changes in this lane.

Five interleaved pairs compare release 2.11.1 `952580ce` with Broadcast on the same private Micro-shaped stack.
Idle windows use 120 seconds and three browsers. Live windows use 300 seconds and 20 browsers.
Live writes update five matchups every 20 seconds. Home fallback polling stays active.
The keep rule exceeds both the larger full spread and 10 percent of the baseline median.
Values below are medians. Gains that do not clear that rule are excluded.

| Metric | Postgres Changes | Broadcast |
| --- | ---: | ---: |
| Idle Realtime DB ms/min | 1,077.66 | 0 |
| Idle total DB calls/min | 156.20 | 37.43 |
| Idle total buffers/min | 273,486 | 502 |
| Live Realtime DB ms/min | 2,488.31 | 1.08 |
| Live total DB calls/min | 870.65 | 777.52 |
| Live total buffers/min | 324,220 | 43,375 |
| Live WebSocket B/client/min | 5,629.54 | 2,248.25 |
| Live delivery p95 ms | 626.76 | 152.64 |

Each live arm delivers all 3,000 logical hints and 1,500 version deliveries.
All 15 post-idle probes arrive in each arm.
Live total DB elapsed time, DB CPU and whole-window WAL remain inside noise.
Failed DNS, OOM and two-second saturation attempts are excluded.

Five write-cost triplets compare 200 committed five-matchup updates per segment.
Compact hints reduce message rows from two to one, payload from 1,091.69 to 671.59 bytes,
message INSERT WAL from 1,924.32 to 1,133 bytes, and INSERT buffers from 10.77 to 5.52.
Those reductions clear noise. Whole-write time and CPU do not.
Compact Broadcast adds a paired median 1,183 WAL bytes per transaction over Postgres-only writers.

The seven live surfaces pass on two independent browser sessions without document reloads.
They cover scores, lineups, trades, claims, forecasts, announcements and auction bids.
Unmodified releases 2.9.1, 2.10.2, 2.11 and 2.11.1 keep updating beside Broadcast.
Each legacy check also receives two Postgres Changes hints and makes eight screen switches without another join.
The writer SQL checks INSERT, UPDATE and DELETE for all 16 tables and rejects foreign topics.
The three-season SQL simulation and built-in message retention rehearsal pass.
The retention probe drops 1,000 six-day-old messages by removing their partition.
These are lane results. Release 2.14 records its own integrated checks separately.

The lane also retains the reproduced Lineup cache recursion regression.
Registering the pending read before subscriber notification prevents re-entry.
Queued reads reject an account or cache generation change.
Cache, roster, trade lock and auto-set regressions remain.

Rerun on the original private mini project `pt4bafablel1`, ports `622xx`, with Node 22:

```sh
node tests/db/l1-realtime-prepare.mjs
node tests/db/l1-realtime-reset.mjs
node tests/db/l1-realtime-build.mjs
node tests/db/l1-realtime-compare.mjs release-check idle 5 120
node tests/db/l1-realtime-compare.mjs release-check live 5 300
node tests/db/l1-realtime-report.mjs release-check idle
node tests/db/l1-realtime-report.mjs release-check live
node tests/db/l1-broadcast-write-compare.mjs release-write-check
node tests/db/l1-realtime-verify.mjs
```

The build needs the lane's runtime server. The verifier runs delivery, all four legacy clients,
writer authorization, three-season SQL and retention checks.
Use the assigned integration stack for release integration. Never reuse another lane's stack.
Raw receipts and measurement outputs are removed in [release cleanup](release-2.14-cleanup.md).

Release 2.14 runs the same assertions in an isolated worktree on this Mac.
The relocation changes harness project IDs, ports, output paths and the Docker socket.
Product source remains unchanged. Both transport exports share the integrated foreground recovery.
The SQL stack must already be running as `pt4bafableint` on `650xx`.

```sh
export DOCKER_CONTEXT=desktop-linux
node tests/db/l1-integration-local.mjs prepare
supabase stop --project-id pt4bafableint --workdir /tmp/pancake-int214/stack
supabase start --workdir /tmp/pancake-int214/stack -x studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit,storage-api
node tests/db/l1-integration-local.mjs build
node tests/db/l1-integration-local.mjs serve
```

Keep the runtime process running. In another terminal, use:

```sh
node tests/db/l1-integration-local.mjs verify
```

Stop the owned runtime with SIGTERM after verification. Stop the stack through Supabase.
Outputs stay under `/tmp/pancake-int214/l1`. Prepare from a clean release head.

The combined-source Release 2.14 checkpoint passes the full 12-step verifier on the assigned Mac stack.
All seven surfaces and all four unchanged legacy releases pass.
The retention probe drops its 1,000-row, 491,520-byte expired partition.
Those delivery, legacy-client and verifier results remain the integration correctness evidence.
The lane measurements above establish the gains. Partial integration captures establish no new gain.
The capture session and runtime ended. Do not restart the 20 paired realtime windows for this release.
