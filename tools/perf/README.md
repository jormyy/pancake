# App performance baseline

Run `node tools/perf/run.mjs` from the repository root.
Run it again to print change and noise for each metric.
Install the lockfile with `npm ci --ignore-scripts` if dependencies are missing.
The command needs Docker, Supabase CLI, Deno, and Playwright Chromium on this Mac.
Install Chromium with `npx playwright install chromium` if it is missing.
Progress goes to stderr. JSON goes to stdout. Any error returns exit code 1.
The command starts its own Supabase project and stops it before returning.
Its temporary config, build, logs, and results stay in `tools/perf/.cache/`.
It never reads environment files or connects to a hosted database.
The seed adapts `scripts/bench/profile-seed.sql` to the current schema.
It adds full-season weekly and daily projections and populated lineup days.
The JSON records exact row counts, database bytes, workload sizes, and source hashes.

Each RPC gets three warmups and 15 measured, authenticated reads.
Each hot loop gets warmup, adaptive batches, 15 samples, and output checks.
Browser runs use 390×844 Chromium, 4× CPU throttle, and five cold/warm pairs.
Meaningful paint requires seeded player text and the screen's real controls.
Interactive time includes a verified day change or opening the Auto-set sheet.
Five alternating control/slow pairs prove sensitivity in each section.
Challenge delays and extra loop work never enter baseline samples.
`node --test tools/perf/harness.test.mjs` checks measurement math and real workloads.
Chromium timings estimate this build on this Mac. They do not measure iPhone Safari.
