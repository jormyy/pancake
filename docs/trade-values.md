# Trade values

## Source access

Michael confirms written permission to collect and copy OneNumberHoops values on 28 October 2026.
No UI or documentation attribution is required.

The public rankings page loads JSON from `https://www.onenumberhoops.com/api/players`.
The response has `success: true` and a `data` array.
Each row includes `id`, `player`, `team`, `pos`, `rank`, `value`, and `age`.
The recorded response contains 450 players and 18 picks.
Pick labels specify three years, two rounds, and early, mid, or late tiers.
The label supplies the pick year; the source draft-class field sometimes disagrees.

The source robots file allows all paths as checked on 28 October 2026.
The worker checks it before each daily data fetch.
The terms require written permission, which Michael confirms.
The worker rejects blocked paths, HTTP failures, malformed responses, and changed row counts.

## Storage and daily work

`sync-trade-values` runs at 07:15 America/New_York through the existing daily work queue.
The database permits one live source attempt per Eastern calendar day.
The cache keeps the last complete response, its hash, and its fetch time.
A failed attempt preserves all published values and remains a failure on later attempts that day.
Use the CSV fallback until the next daily attempt.

`dynasty_rankings.trade_value` holds the scaled player values.
Ranks and production statistics retain their meanings.
The existing dynasty input function prefers OneNumberHoops and returns its numeric value.
Frozen trade inputs include pick value bands and their fetch time.
The old ranking worker remains enabled.
Its rows cannot take priority over OneNumberHoops rows.

`dynasty_pick_values` holds 18 source picks and nine derived third-round bases.
`get_dynasty_pick_values` applies the league floor when reading those bases.
Publication uses one transaction and refuses older snapshots.
Worker lease checks protect the new tables.

## Data contract

Divide source values by 10 to use the 0–1000 scale.
Do not change ranks into values or overwrite production statistics.
Store the source number separately from the rank in the existing dynasty-ranking table.

The parser requires 450 player rows and 18 distinct pick rows across three consecutive years.
A missing field, duplicate identity, duplicate rank, invalid position, or incomplete pick grid rejects the whole import.
The recorded endpoint response and public page are under `tests/fixtures/trade-values/`.
The source record includes the response hash and fetch time.
Tests read fixtures and use fake fetches; they never request the live source.

## CSV fallback

Send an internal worker request with `format: "csv"` and the CSV text in `content`.
Use this exact header:

```csv
source_id,name,team,positions,rank,value,age
```

Use the original source scale for `value`.
Use slash-separated positions and standard CSV quoting.
Include all 450 players and 18 picks.
The same validation and atomic publication rules apply to both formats.
A recorded JSON import uses `format: "json"` and its response text in `content`.

## Third-round picks

Calculate 40% of the same-year, same-tier second-round value after scaling.
The stored third-round figure is the unfloored base.
The league read applies the replacement-value floor.
Use up to five available players, selected by current league production, for the replacement-value mean.
Without that sample, use `180 * 200 / (team count * roster size)`, bounded from 50 to 500.
This follows the current trade-estimate replacement rule.
No league scoring adjustment changes the imported values.

## Review list

The recorded player fixture matches 445 of 450 source players automatically: 98.89%.
Five names remain for review: Alex Caruso, Jamaree Bouyea, Vince Williams Jr., Alex Toohey, and Lonzo Ball.
Their source positions conflict with Pancake, or more than one Pancake identity matches.

Commissioners of active leagues and admins can read `trade_value_reviews`.
Ordinary members and anonymous users cannot read it.
Filter `resolved_player_id IS NULL` for pending rows.
Call `resolve_trade_value_review(source_id, player_id)` to approve a match.
The next sync preserves approved matches, including approvals made while a fetch runs.

## Verification

The live worker fetch and the next cached request succeed on the private stack.
The fixture import and CSV import write all 450 player rows and 27 pick rows.
Tests check source structure, matching, permissions, review resolution, stale imports, invalid imports, and daily scheduling.
The season replay supplies the recorded response for this work kind and makes no source requests.
Migration attestations come from a clean local rebuild.

## Display readers

Players rankings and player profiles show the stored player value.
The trade analyzer uses the same value without age, health, or scoring adjustments.
Each strategy uses the same source number.
Missing source rows retain the previous value calculation.

Pick readers use the stored early, middle, and late values.
Known slots select their corresponding third of the draft order.
Unknown slots use the middle value and show the early-to-late range.
Pick labels use the draft year rather than the following season year.

Trade cards prefer current source values.
When a source value is absent, they use the saved asset value or saved team total.
Saved analysis remains unchanged.
Publication and review approval notify league readers to refresh their caches.
Screen layouts and trade comparison rules remain unchanged.

## Original value branch verification

The targeted Vitest runs pass 135 tests with zero failures.
The core decision-engine tests pass 14 tests.
The private-stack test runs separately on the mini:

```sh
npx vitest run tests/trade-values*.test.ts tests/trade-value-readers.test.ts tests/edge-function-inventory.test.ts tests/db-function-source-parity.test.ts tests/lib/dynasty-decisions.test.ts tests/hooks/dynasty-trade-analysis.test.ts tests/hooks/dynasty-rankings-identity.test.ts tests/hooks/dynasty-rankings-reconnect.test.ts tests/e2e-attestation-head.test.ts tests/db-security-catalog-contract.test.ts tests/components/trades/saved-estimate-text.test.ts tests/app/dynasty-tools-ui.test.ts tests/lib/trades-read.test.ts tests/trade-card-analyze.test.ts --maxWorkers=2
```

These commands run on the private stack with its Docker and browser environment set:

```sh
PANCAKE_TRADE_VALUE_STACK=1 npx vitest run tests/e2e/trade-value-stack.test.ts --maxWorkers=1
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-values.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-value-readers.sql
deno check --no-lock supabase/functions/sync-trade-values/index.ts
node scripts/check-db-function-sources.mjs --check-catalog
PANCAKE_TEST_DB_PORT=57822 node scripts/regenerate-release-history-attestations.mjs --check
```

The integration test passes 27 checks; the sync SQL test passes 19 checks.
The reader SQL test passes six checks, including source preference, legacy fallback, and known pick slots.
The browser passes six checks: rankings, refresh, picks, profile, trade cards, and analyzer.
Browser screenshots and result records stay outside the repository.
Changing a stored player value makes the source-preference assertion fail.
Removing the reviewed-match override makes the SQL race check fail.
The transaction rolls back that negative control.

The season cron checks pass 19 tests:

```sh
node --test scripts/season-sim/cron.test.mjs scripts/season-sim/migration-cron.test.mjs scripts/season-sim/cron-dispatcher.test.mjs
```

These counts describe the original value branch before integration.

## Release 2.5 integration

Apply all migrations through `20261123000100` before deploying the worker or its readers.
The final migration preserves daily value work beside league-midnight waivers.
Both compact overview and legacy player responses include the stored source value.
Cards without current or saved values omit the comparison.
The schedule regression uses unfinished invocation fixtures and checks idle and completed states.
The direct hint drain retains its half-minute cron schedule without leased hint work.
[Integration evidence](release-2.5-integration.md) records the full suite and season checks.
