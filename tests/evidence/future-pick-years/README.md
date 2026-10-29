# Future pick years verification

Verified on the private Mac mini stack `pt4bafablepk`, using ports 625xx and Node 22.
The supplied backup was restored at `20261029000800`, then migrated through release 2.8 and `20261214000700_future_pick_years.sql`.
Production was never contacted.

OFFICIAL LEAGUE `faab8d8f-6a60-4bbc-8f5d-44050b652cdd` has 30 picks per year for 2028 through 2032.
The backfill adds 60 assets, increasing the inventory from 90 to 150.
Every new pick has three rounds per team and identical original and current owners.
Existing picks retain every column, including IDs, ownership, usage, and predictions.
Other leagues, their versions, their hints, and other application tables stay unchanged.
The target league's timestamp, version, inventory events, and queued settings notices follow the normal triggers.
A second migration run changes no pick rows or league versions.

## Checks

| Check | Result |
| --- | --- |
| Backfill and preservation recipe | 83 assertions passed |
| Create, join, setup rollover, and season advance at 3 and 5 years | 12 assertions passed |
| Commissioner limits, authorization, lowering protection, values, and real fifth-year trade offer | 20 assertions passed |
| Trade window and pick notices | 6 assertions passed |
| Cleanup with used assets, assignments, trades, activity, and arbitrary foreign keys | 5 assertions passed |
| Final focused Vitest run | 927 passed across 11 files |
| Follow-up after fixing the live relationship ambiguity | 23 passed across 4 files |
| Quality, lint, application types, test types, and other quality checks | Passed |
| Live database types and function catalog | Passed |
| Separate agent-browser at 390 px | Both lists show 2028–2032; a 2032 Round 3 pick selects |

The full Vitest suite ran once: 4,651 passed, 48 skipped, and 9 initially failed.
The failures were release-order documentation, four year-label expectations, and four mocks missing the new horizon read.
All nine pass in the focused rerun.
The new commissioner control has seven passing tests.
The live browser also reproduced a PostgREST relationship ambiguity in the new horizon query.
The explicit `league_seasons_league_id_fkey` relationship fixes it.

## Reproduction

Use only the lane checkout on the mini with its 625xx configuration and local generated environment.
Transfer the supplied schema and data files into the lane's `backup` directory before setup.
The setup removes those transferred files after restoring and sanitizing the private data.

```sh
node tests/e2e/future-pick-mini.mjs setup
node tests/e2e/future-pick-mini.mjs verify
node tests/e2e/future-pick-mini.mjs generate
node tests/e2e/future-pick-mini.mjs prepare-web
node tests/e2e/future-pick-web.mjs
supabase functions serve api --no-verify-jwt --env-file ../edge.env
node tests/e2e/future-pick-browser.mjs
node tests/e2e/future-pick-mini.mjs stop
```

Run the web server and Edge server separately while capturing.
The SQL recipe can also run with `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/future-pick-backfill.sql` from the repository root.
After the first successful backfill, use `verify --skip-backfill` for the remaining recipes.
The backfill recipe starts from the original three-year data shape and checks its own second run.

```sh
npx vitest run --maxWorkers=1
npm run check:quality
npm run check:database-types
npm run check:db-function-catalog
```

Scheduled jobs remain disabled throughout verification.
The database HTTP queue blocks external URLs, and browser navigation is restricted to loopback.
The private stack and temporary web and Edge servers stop after the checks.
No emails, push notifications, push, PR, deployment, or CI run is sent.

## Captures

- [League Picks at 390 px](league-picks-390.png)
- [Trade pick list at 390 px](trade-picks-390.png)
- [Browser assertions](browser-result.json)
