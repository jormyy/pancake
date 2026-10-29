Players scrolling regression

The browser used a separate agent-browser session at 390 × 844 on the private Mac mini stack pt4bafableps, within port block 626xx. The database restored 67 tables from the October 28 backup. The schema was 1,272,334 bytes and the data was 86,409,609 bytes. Cron jobs were disabled. Database and browser network guards blocked external requests.

Before uses app commit 628c7def. After uses app commit 5afe9c55. Each scenario starts with at least three loaded pages and a scroll offset of 1,800 px. Version cases publish through private.publish_league_version with the worker's topic and source table. These are controlled local publication events. They do not run the external data ingestion jobs.

| Trigger | Before rows / offset | After rows / offset | Players reads before → after |
| --- | --- | --- | --- |
| Trade value publication | 60 / 1800 | 60 / 1800 | 0 → 0 |
| Matchup forecast publication | 60 / 1800 | 60 / 1800 | 0 → 0 |
| Standings publication | 40 / 556 | 60 / 1800 | 2 → 0 |
| Live stats publication | 40 / 556 | 60 / 1800 | 2 → 3 |
| Leave Players and return | 20 / 0 | 60 / 1800 | 0 → 0 |
| Offline and online | 60 / 1800 | 60 / 1800 | 0 → 0 |
| Delayed cache revalidation | 40 / 556 | 60 / 1800 | 2 → 3 |
| Next page racing refresh | 40 / 556 | 80 / 2756 | 4 → 5 |

The race intentionally scrolls from 1,800 px to the current end at 2,756 px to request page four. The after report records that position as beforeRefresh and verifies the same visible rows and offset remain after the refresh. Both completion orders also have unit coverage.

The old refresh collapses to 20 rows. FlashList immediately requests another page at its shortened end, producing the observed 40-row result. The focus case stays at 20 rows.

Each phase directory contains before and after PNG frames for every trigger, an extra frame during revalidation, report.json with visible player labels and their positions, and requests.json with request paths, search parameters, status and timestamps. Request logs exclude authorization headers. All seven fixed after frames outside the paging race are byte-for-byte identical to the corresponding original before frames. The after race also has a frame while page four is pending.

The initial regression test run on the original hook failed 9 tests and passed 4. The final focused run passed 89 tests across seven files. The full Vitest run passed 4,681 tests, skipped 48, and had no failures. npm run check:quality passed, including lint, application and test typechecks, browser-script typechecks, Knip and the remaining quality checks.

Run the stack on the mini with PERF_LAB_ON_MINI=1, PERF_LAB_LANE=fable-ui20, PERF_LAB_PROJECT=pt4bafableps, PERF_LAB_PORT_PREFIX=626 and PERF_LAB_TLS_SELF_SIGNED=1. Remove the lane's old stop file before starting another run. Place the supplied schema.sql and data.sql copies in the lane's backup directory first. Start node tests/e2e/players-scroll-stack.mjs. Run node tests/e2e/players-scroll-browser.mjs before on the original artifact and after on the fixed artifact. Touch the lane's stop file to stop the stack. The stack runner deletes its backup copies and restores its local Supabase configuration during cleanup.

Cleanup passed. The private stack stopped, its configuration was restored, its backup copies were deleted, and the owned automation sessions closed.
