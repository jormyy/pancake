# Verified local game-night result

Training reduction: 99.829%. Training median: 3.661 anonymous refaults/s; ceiling: 35.092.

Held-out rate: 11.219 anonymous refaults/s; ceiling: 158.375.

The primary counter is the database cgroup memory.stat workingset_refault_anon delta divided by elapsed seconds. VM swap stays diagnostic. Ordinary per-cgroup swap-out traffic is unavailable on this kernel.

The original reports regrade to a 1,213.847 refaults/s median across three runs. The third report lacks MemAvailable, so its historical headroom remains uncertain. Original evidence and VM rates remain unchanged. Fresh paired runs decide acceptance.

## Repeated measurements

| Phase | n | Median /s | Minimum /s | Maximum /s | Spread /s |
| --- | --- | --- | --- | --- | --- |
| Settings reference | 3 | 701.832 | 592.030 | 740.330 | 148.301 |
| Approved settings | 3 | 142.640 | 141.839 | 152.506 | 10.667 |
| Architecture reference | 3 | 2,137.201 | 2,098.933 | 2,192.644 | 93.711 |
| Public architecture | 3 | 3.661 | 1.632 | 6.168 | 4.535 |
| Held-out reference | 3 | 3,167.493 | 3,114.448 | 3,432.218 | 317.770 |
| Held-out architecture | 1 | 11.219 | — | — | — |

All accepted runs use 192 MiB and the unchanged synthetic fixture. Training follows ABBAAB. The first reference is reused with explicit provenance; the intervening 64 MB trial stays outside the comparison. References include the recorded retry and dispatch correctness repairs. The 1 GiB MemAvailable floor is fixed before these runs. Foreign containers stay untouched.

The settings-only phase omits simulated phones. The architecture phase includes ten phones on both sides. Compare each candidate with its own paired reference; percentages from different phases are not additive.

The selected candidate uses 32 MB shared_buffers and a two-connection PostgREST pool. It keeps thirty-second phone updates and thirty-minute database recovery checkpoints. No sixty-second variant is needed when this target passes. The result combines architecture and runtime settings; it does not assign a separate gain to each.

## Positive replay gates

| Run | Phone p50 ms | Phone p95 ms | Missing updates | Final state | Work | Failed jobs | Disk operations/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| architecture-1 | 18,689.000 | 30,606.000 | 0 | True | True | 0 | 17.786 |
| architecture-2 | 15,037.000 | 25,707.000 | 0 | True | True | 0 | 53.614 |
| architecture-3 | 16,147.000 | 27,714.000 | 0 | True | True | 0 | 24.354 |
| held-out | 19,350.000 | 30,912.000 | 0 | True | True | 0 | 44.980 |

| Action | Training limit ms | Training median ms | Training maximum ms | Held-out ms | Held-out limit ms |
| --- | --- | --- | --- | --- | --- |
| rosterMove | 104.000 | 48.000 | 51.000 | 30.000 | 116.000 |
| lineupSave | 169.000 | 23.000 | 38.000 | 40.000 | 175.000 |
| tradeOffer | 1,441.000 | 75.000 | 78.000 | 55.000 | 232.000 |
| tradeAccept | 507.000 | 61.000 | 75.000 | 66.000 | 1,426.000 |
| waiverResult | 23,778.000 | 20,128.000 | 20,143.000 | 20,135.000 | 23,759.000 |

## Before and after

| Measured four-minute window | Reference median | Candidate median |
| --- | --- | --- |
| providerCalls | 79.000 | 75.000 |
| providerBytes | 1,589,531.000 | 1,372,190.000 |
| edgeCalls | 323.000 | 111.000 |
| databaseApiCalls | 1,520.000 | 343.000 |
| databaseApiBytes | 7,198,315.000 | 5,841,356.000 |
| phoneViewCalls | 310.000 | 100.000 |
| phoneViewBytes | 5,396,957.000 | 5,105,006.000 |
| realtimeDeliveredBytes | 808,910.000 | 122,700.000 |
| databaseGrowthBytes | 1,523,712.000 | 811,008.000 |
| postWindowGrowthBytes | 0.000 | 286,720.000 |
| homeReadP95Ms | 452.000 | 90.000 |
| phoneCalculationP95Ms | 0.011 | 0.293 |

Provider bytes, database API bytes, phone response bytes, and Realtime bytes are separate legs. The decoded transfer projection can include both database-to-Edge and Edge-to-phone traffic. It is not a hosted billing measurement.

## Vercel projection

Ten phones, six hours/night, thirty nights. Origin estimates allow eleven independent cache regions. CPU and memory time use the local fake feed; real deployment billing remains unverified.

Median snapshot size: 8,788.000 raw bytes and 2,129.000 gzip bytes. Median per-run route p95: 8.128 ms. Home timing is API response latency; physical-device rendering is unmeasured.

Held-out snapshot: 15,025.000 raw bytes and 3,279.000 gzip bytes. Its route p95 is 10.087 ms.

| Resource | Unit | Training median | Training maximum | Held-out | Free limit | Maximum share |
| --- | --- | --- | --- | --- | --- | --- |
| requests | requests | 259,053.203 | 264,461.158 | 232,080.092 | 1,000,000.000 | 26.45% |
| invocations | invocations | 237,475.325 | 237,482.248 | 207,792.640 | 1,000,000.000 | 23.75% |
| transfer | bytes | 545,306,992.704 | 563,302,266.310 | 760,990,621.512 | 100,000,000,000.000 | 0.76% |
| originTransfer | bytes | 2,086,933,160.091 | 2,086,993,998.809 | 3,122,084,423.048 | 10,000,000,000.000 | 31.22% |
| activeCpu | hours | 0.374 | 0.392 | 0.416 | 4.000 | 10.39% |
| memory | GB-hours at 2 GB allocation | 0.907 | 0.936 | 0.885 | 360.000 | 0.26% |

The retry upper bound is 453,600 CDN requests, including the worker. At the median snapshot size this is 0.966 GB compressed transfer. Eleven regions allow 237,600 normal origin calls, or 2.088 GB raw origin transfer.

## Supabase projection

| Resource | Unit | Training median | Training maximum | Held-out | Free limit | Maximum share |
| --- | --- | --- | --- | --- | --- | --- |
| database | bytes | 265,735,315.000 | 265,858,195.000 | 266,095,763.000 | 500,000,000.000 | 53.22% |
| memory | peak sampled cgroup memory.current bytes | 189,075,456.000 | 192,614,400.000 | 194,572,288.000 | 500,000,000.000 | 38.91% |
| diskIo | operations per second | 24.354 | 53.614 | 44.980 | 250.000 | 21.45% |
| transfer | decoded payload bytes | 29,871,656,037.215 | 29,978,485,695.010 | 30,847,036,064.700 | 5,000,000,000.000 | 616.94% |
| edgeInvocations | invocations including API reads | 299,542.740 | 323,839.430 | 296,846.629 | 500,000.000 | 64.77% |
| realtimeMessages | messages upper estimate | 1,295,319.957 | 1,295,357.718 | 1,295,330.746 | 2,000,000.000 | 64.77% |
| realtimeConnections | simultaneous phone connections; lab adds one observer | 10.000 | 10.000 | 10.000 | 200.000 | 5.00% |

The disk limit is a sustained operations-per-second baseline, not a monthly quota. The projection repeats the fixture action rate for all playing hours. It is a stress upper bound, not an observed monthly user workload.

## Named risks

- Supabase database: the larger training or held-out projection reaches 53.2% of the free allowance.

- Supabase transfer: the larger training or held-out projection reaches 616.9% of the free allowance.

- Supabase edgeInvocations: the larger training or held-out projection reaches 64.8% of the free allowance.

- Supabase realtimeMessages: the larger training or held-out projection reaches 64.8% of the free allowance.

Candidate median database allocation: 265,022,611 bytes before the window, 265,735,315 at its end, and 266,038,419 after settlement.

Database allocation includes reusable pages. The 265 MB fixture already exceeds half the 500 MB allowance. Retain official stats and results; bound successful-job, broadcast and transition history. Measure real growth before selecting further retention changes. This work never reads production.

A physical phone, sustained live provider access from Vercel, deployed cache behavior, and actual billing remain rollout checks. The supplied single Vercel probe remains the only deployed measurement.

## Remaining costs and hypotheses

- cgroupAnonPeakBytes: median 125,657,088.000.

- cgroupShmemPeakBytes: median 49,897,472.000.

- cgroupMajorFaultsPerSecond: median 2.494.

- cgroupSwapPeakBytes: median 63,700,992.000.

- walBytesPerMinute: median 302,424.548.

- newSessionsPerMinute: median 83.456.

- cronRunsPerMinute: median 0.999.

| Function | Execution seconds/min | Inclusive WAL bytes/min | Read blocks |
| --- | --- | --- | --- |
| view_home | 0.209 | 34.982 | 0.000 |
| compute_fantasy_points | 0.103 | 0.000 | 0.000 |
| unattributed-read | 0.052 | 28,440.384 | 14.000 |
| dispatch_work | 0.050 | 72,844.881 | 0.000 |
| unattributed-write | 0.048 | 259,475.964 | 125.000 |
| is_regular_season_game_id | 0.044 | 18,245.921 | 2.000 |
| drop_player_atomic | 0.016 | 3,435.796 | 88.000 |
| view_game_day | 0.014 | 0.000 | 0.000 |
| work_execute | 0.011 | 28,044.595 | 0.000 |
| save_final_game_snapshot_atomic | 0.009 | 115,723.495 | 41.000 |
| submit_trade_offer_atomic | 0.009 | 5,525.849 | 32.000 |
| accept_trade_atomic | 0.008 | 7,504.529 | 3.000 |

| Largest inclusive WAL sources | Median bytes/min |
| --- | --- |
| unattributed-write | 259,475.964 |
| save_final_game_snapshot_atomic | 115,723.495 |
| dispatch_work | 72,844.881 |
| lineup_game_available | 32,969.941 |
| save_live_scoreboard_atomic | 32,969.941 |
| unattributed-read | 28,440.384 |
| process_due_waiver_claims_atomic | 28,109.571 |
| process_next_waiver_claim_atomic | 28,109.571 |

| Sampled memory category | Median peak bytes |
| --- | --- |
| anonymous backend memory | 125,657,088.000 |
| shared memory | 49,897,472.000 |

Nested statement totals overlap. They do not assign causal swap pages to functions. Per-backend diagnostics show many small cached plans, not one enormous plan. Lower pool size limits duplication; public polling avoids repeated official-save chains.

Further candidates are narrower saved-view responses, coalesced equal Realtime hints, and fewer empty scheduler calls. Preserve action notifications, auth, locks, safety checks and final correction. Player-stat indexes stay unless an equivalent access path is proven. Do not remove managed Realtime, cron or pg_net services.

## Verification and provenance

Measured candidate source: `2efc33e42d6a24baab8e686f0768bf897993a69b+workers:a316b45e627e`. Harness SHA-256: `8aa733aedd314a5621967a7fafb5b7e65befcffb496a95f1e1091697f93b98d1`.

Raw reports retain timed work, quality gates, final-state checks, errors, dead work, resource counters, settings, source hashes, payloads, provider calls and post-window costs. Negative controls and the final test summary are separate artifacts in this evidence directory.

The summary freshness gate now also rejects a failed phone freshness result. The main phone gate already rejected missing updates. All sixteen passing paired reports retain their original files and outcomes under the strengthened quality-v2 regrade. No resource counters change.

Training evidence: `/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/architecture-cgroup-32`. Held-out evidence: `/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/held-out-cgroup-32`.

The 68 generic SQL failures are classified against e5f16211. Forty-one outcomes match; all 27 different cases pass after fixture repairs. Expected release-attestation failures stay until release. The two core failures reproduce unchanged at e5f16211.

## Sources

- https://vercel.com/docs/plans/hobby

- https://vercel.com/docs/caching/cache-control-headers

- https://supabase.com/pricing

- https://supabase.com/docs/guides/platform/compute-and-disk

- https://supabase.com/docs/guides/platform/manage-your-usage/egress

- https://supabase.com/docs/guides/database/custom-postgres-config

- https://supabase.com/docs/reference/api/v1-update-postgrest-service-config
