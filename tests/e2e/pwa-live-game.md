# Home foreground recovery

Keep `5a417963` and `f59c5e67` together.
Cached Home foreground recovery shares the live recovery version request while keeping its scheduled screen read.
Failed validation retains the prompt retry. Route changes, reconnects and manual refresh keep normal validation.

Five paired 22-minute windows compare release 2.11.1 `952580ce` with the candidate.
Each arm uses three synthetic managers, separate localhost origins and fresh automation browser pages.
Each window includes 20 minutes of native hidden state and score ingest every 45 seconds.
Launch order alternates. Cost rates include the full measured window and exclude initial Home loading.
Client DB calls include REST transactions and GoTrue lookups caused by client Edge requests.
The noise rule is the larger full relative spread across both arms, with a 10 percent floor.

| Metric per manager | Baseline median | Candidate median | Noise | Result |
| --- | ---: | ---: | ---: | --- |
| Requests/min | 1.348 | 1.136 | 11.2% | 15.7% reduction; passes |
| Client DB calls/min | 1.530 | 1.272 | 15.8% | 16.8% reduction; passes |
| Transfer B/min | 8,582.529 | 8,244.547 | 10.0% | Within noise |
| Decoded B/min | 14,077.736 | 12,929.385 | 16.3% | Within noise |
| Foreground version requests | 2 | 1 | 10.0% | 50% reduction; passes |
| Visible score p95 ms | 837 | 833 | 33.8% | Freshness passes |
| Foreground catch-up p95 ms | 407 | 322 | 38.8% | Freshness passes |

All five paired score, roster and standings comparisons pass.
No browser page errors or tasks above 50 ms are recorded.
Byte transfer, heap, duplicate requests and main-thread time do not establish gains beyond noise.
The other original Home, tab-tour and slow-network profiles were not measured in this continuation.
A timed-out pair is discarded and rerun with the same workload and artifacts.
Earlier failed setup and transport attempts supply no keep evidence.

The retained foreground regression checks the updated score and one version request after 20 hidden minutes.
The outage regression checks that failed foreground validation retries promptly.
The frozen contract rejects rendered mutations, freshness regressions and gains below noise.
The existing matchup-navigation browser harness retains navigation coverage.

The original Mac recipe uses Docker context `desktop-linux`, project `pt4bafablec1`, ports `649xx`, and Node 22.
Use a separate automation browser. Never reuse the user's browser.
Cron and external HTTP stay disabled. No real email or push is sent.

```sh
node tests/e2e/pwa-live-game/stack.mjs
node tests/e2e/pwa-live-game/build.mjs baseline
node tests/e2e/pwa-live-game/build.mjs candidate
PWA_SCENARIOS=background node tests/e2e/pwa-live-game/measure.mjs
PWA_SCENARIOS=background node tests/e2e/pwa-live-game/report.mjs
npx vitest run tests/hooks/matchup-live-recovery.test.ts tests/e2e/pwa-live-game-contract.test.ts
```

Keep the private stack process running while building and measuring.
The build disables dotenv, telemetry and external predecessor recovery.
The measurement harness runs the private Edge runtime and reads only its generated local fixtures.
Use the assigned integration stack for release checks.
Raw measurement outputs are listed in [release cleanup](../../docs/release-2.14-cleanup.md).
