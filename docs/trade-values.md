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
The database permits one successful live sync per Eastern calendar day.
The cache keeps the last complete response, its hash, and its fetch time.
A failed attempt preserves all published values and releases its daily claim.
A later retry can publish on the same day.
An abandoned claim expires after three minutes.

`dynasty_rankings.trade_value` holds the scaled player values.
Ranks and production statistics retain their meanings.
Ranking screens read Hashtag Basketball ranks and point forecasts.
Frozen trade inputs include pick value bands and their fetch time.
The Hashtag ranking worker and hourly schedule are restored.
Trade publication does not change shared Hashtag player ranks.

`dynasty_pick_values` holds 18 source picks and nine derived third-round bases.
`get_dynasty_pick_values` applies the league floor when reading those bases.
Publication uses one transaction and refuses older snapshots.
Worker lease checks protect the new tables.

## Fetch timing and retries

On 28 October 2026, the Mac mini receives the full 129,850-byte JSON with HTTP 200.
Four measured requests take 16.6, 6.5, 55.7, and 10.2 seconds.
The user agent does not cause a block.
The robots file responds in 0.2 seconds.
The apex host redirects to `www` with HTTP 307.
The worker requests `www` directly.

Each player fetch has a 75-second timeout, including its response body.
The worker makes two attempts, with a one-second pause after the first failure.
The robots request has a five-second timeout.
The source deadline is 110 seconds from the start of the sync, including robots and the pause.
The second attempt uses the remaining source time when fewer than 75 seconds remain.
Database work and publication share a 115-second deadline from the start of the sync.
Failure cleanup has five more seconds.
Invocation startup and lease checks allow ten seconds; final error recording allows five seconds.
The total controlled invocation budget is 135 seconds, below the 140-second limit.

Apply migration `20261124000100` before installing the updated worker.
If fetching fails, the worker calls the service-only `fail_trade_value_sync` function through RPC.
The function releases the claim and queues one new work item for 30 minutes later.
The retry key is `sync-trade-values-retry-<n>-<date>`.
The payload holds `retry` and `retryDate`; the date uses Eastern time.
The first failure queues retry 1; retry 4 is the last retry for that day.
Duplicate callbacks cannot create more work.
The queue keeps the original fetch error and skips its usual short retry delays for these failures.
The sync record also keeps the failure.
Use the CSV fallback if all four retries fail.

The offline fetch tests prove 60-second success, the 75-second attempt timeout, and the 110-second source deadline.
Database checks prove retry limits, the 30-minute delay, error retention, and recovery on the same day.
The real worker handler also passes with fake provider responses and the private database.

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

Release checks use recorded source responses and fake provider fetches.
The live provider is not contacted during this integration.
The fixture import and CSV import write all 450 player rows and 27 pick rows.
Tests check source structure, matching, permissions, review resolution, stale imports, invalid imports, and daily scheduling.
The season replay supplies the recorded response for this work kind and makes no source requests.
Migration attestations come from a clean local rebuild.

## Display readers

Ranking screens and player profiles use Hashtag Basketball.
Future rookie picks use the original ranking curve.
See [the source map](dynasty-rankings-restoration.md) for each reader.
The trade analyzer uses the same value without age, health, or scoring adjustments.
Each strategy uses the same source number.
Trade assets without imported values contribute zero.
Trade estimates use zero for missing source values.

Trade pick readers use the stored early, middle, and late values.
Known slots select their corresponding third of the draft order.
Unknown slots use their predicted value and show the early-to-late range.
Pick labels use the draft year rather than the following season year.

Trade cards prefer current source values.
When a source value is absent, they use the saved asset value or saved team total.
Original quote contents remain unchanged.
Re-analysis refreshes the saved estimate link and keeps both snapshots in history.
Publication and review approval notify league readers to refresh their caches.
Screen layouts remain unchanged.

## Checked commands

[Release 2.6 integration](release-2.6-integration.md) records current counts and check limits.
Use Node 22 for the Mac checks.
Use only the private mini stack for database and Edge checks.
Load the recorded player and value fixtures before running the value SQL checks.
The schedule checks require an empty NBA game schedule.

```sh
npx vitest run
npm run test --workspace core
npm run check:quality
node --test scripts/season-sim/*.test.mjs
```

Run these checks against the private database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-values.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-values-retries.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-value-readers.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-estimate-reanalysis.sql
npm run check:db-function-catalog
npm run check:database-types
node scripts/regenerate-release-history-attestations.mjs --check
```

Set `PANCAKE_TEST_DB_PORT` to the private database port.
Recorded fixture imports and fake fetches avoid the live provider.
Earlier branch browser and backup results do not verify the integrated release.

## Trade scoring

The calculator page and FAQ describe the behavior without an exact adjustment equation.
Checked on 28 October 2026:
https://www.onenumberhoops.com/calculator
https://www.onenumberhoops.com/faq

`onenumber-trade-v1` uses the following explicit rules.
Each total sums its imported player values, pick values, and FAAB values.
Missing imported player or pick values contribute zero and appear in missing inputs.
Known pick slots select their tier; unknown slots use the stored predicted value.
Third-round values already include the derived base and league replacement floor.
Age, health, strategy, and league scoring do not change imported values.

FAAB retains the existing overall rate: round(amount / budget × (45 + 105 × free-agent quality)).
Free-agent quality is mean available-player fantasy points / 65, bounded from zero to one.
Without that sample, quality is 0.5.
A missing or zero budget gives zero FAAB value.
All strategies use the overall rate.

Only positive-value pieces count for adjustments.
When piece counts differ, the smaller package gets a bonus if it contains the unique best asset.
The bonus is best value × 0.15 × excess pieces, with at most three excess pieces.
When opposing best assets differ by at most 10% of the larger value, examine the next strongest asset.
That third asset earns 25% extra credit when it reaches 50% of the best asset.
Equal third assets receive no credit because the credits cancel.
Adjustments use all asset kinds, including picks and valued FAAB.
For several teams, each team compares its sent and received packages.

Fairness uses absolute adjusted difference / larger adjusted total, with an inclusive 5% limit.
Two zero totals are fair.
Raw totals retain the existing response fields.
`packageEffect` holds net adjustment; `impact` becomes zero within the fairness limit.
Replacement and roster-slot effects are zero.
The estimate worker and Analyzer use this same calculation.
Saved quotes record the formula version in `model_version`.

| Sent | Received | Net adjustment | Impact | Fair |
| --- | --- | ---: | ---: | --- |
| 1000 | 250 + 250 + 250 + 250 | -450 | -450 | No |
| 1000 | 950 + 600 | 0 | 550 | No |
| 1000 | 899 + 600 | -150 | 349 | No |
| 1000 | 950 | 0 | 0 | Yes |
| 1000 | 949.999 | 0 | -50.001 | No |
| 1000 | 950.001 | 0 | 0 | Yes |


## One-time trade re-analysis

Migration `20261124000200` queues the versioned re-analysis through the existing trade-estimate worker.
Publish the imported values before that work runs.
The worker reads at most 25 trades per request and queues the next batch when work remains.
It covers pending, accepted, and completed trades in every league, including deleted leagues and past seasons.
Current ownership does not block historical trades.
Inputs use the current league season when available, otherwise the trade season.

`trade_estimate_history` keeps the original saved estimate and its complete quote.
It also keeps the new quote with frozen inputs and `onenumber-trade-v1`.
An absent original estimate stays recorded as absent.
Each trade and formula pair is unique.
Saving locks the trade and returns the existing quote on retry.
Both quote-retention paths preserve every linked history quote.
Only the service can run the re-analysis functions.
Members can read history only for trades they can already read.

Migration `20261124000300` reads pick bands once per estimate.
It also materializes available-player production before joining imported rankings for the pick floor.
The old join reads production 450 times on the backup and exceeds the service timeout.
The measured query falls from 3442.097 ms to 17.944 ms on the same private stack.

## Pick predictions

Release 2.6 applies `20261124000100` through `20261124000400` after the supplied production head `20261123000100`.
The combined history contains 625 migrations.
The daily value retry rules remain active beside the prediction chain.

Team strength uses current imported values from the original pick owner's roster.
The top ten projected players count fully, the next five count half, and other players count 10%.
The age factor rises from 0.65 at 18 to 0.95 at 24 and 1.0 at 27.
It stays at 1.0 through 29 and falls to 0.2 at 40.
Unknown ages use 1.0.
Future years add their distance to each player's age before sorting the roster.

Current expected wins equal recorded wins plus half of ties plus the sum of remaining matchup win probabilities.
Each probability uses a logistic of the team-strength difference.
Its scale is one quarter of the league's mean strength, with a floor of one.
Win variance sums p × (1 − p) across those matchups.
The league win distribution combines each team's variance and its difference from the league mean.
Early and late boundaries use normal quantiles at one third and two thirds of that distribution.
Each team's normal finish distribution supplies its early and late odds; the remainder is middle odds.
There are no random draws or season simulations.

Future seasons reset the record and use equal opponent shares of the current full schedule length.
An absent schedule uses 18 games per team.
Future early and late odds shrink by exp(−years / 2); the middle receives the remaining probability.
The value is the weighted sum of the three imported tier values.
A missing draft class uses the nearest published class.
Third-round bands retain the 40% second-round rule and league replacement floor.
Known draft slots use a single tier with probability one.

`draft_picks` stores tier odds, value, source bands, strength, expected wins, variance, model, source hash, and refresh time.
Existing trade reads and frozen estimate inputs consume those predictions.
Successful source publication atomically queues the daily pick refresh.
The refresh saves every league before queuing the one-time `onenumber-trade-v1-picks-v1` trade re-analysis.
This history version keeps the original and prior estimate snapshots.
Stale source hashes cannot publish predictions or queue that re-analysis.
The daily work key prevents duplicate refreshes for the same source and day.

The Hashtag work kind, hourly wake, scraper, writer, fixtures, and tests are restored.
The ranking writer updates only its own source rows.
Its five-year view also maintains shared player ranks.
News, projections, and trade estimates remain.

Earlier branch backup checks price 90 picks and refresh three trades.
Release checks use separate fixtures and retain their own results.
Four unit cases include an independent 75% win calculation and strong-versus-weak roster checks before any results.
Changing the logistic scale makes the calculation test fail; restoring it passes.

Earlier branch backup checks use a different private stack.
Their results do not replace the release 2.6 checks.
The pick worker uses the internal `api/trades/pick-values-work` route.
The existing API registration supplies its authentication boundary.
The queue calls that route after successful value publication.
The committed Supabase configuration remains unchanged.
The former ranking endpoint returns HTTP 410 without fetching or writing data.
The four-part fallback formula, strategy weights, and obsolete core tests are removed.
All strategy fields retain the same imported values for screen compatibility.


## Release verification

The integrated release uses private project `pt4bafabler26` and ports `586xx`.
All four generated database artifacts come from the combined migration history.
The retry checks preserve the original fetch error, claim release, and bounded retry count.
Pick-reader checks cover trade details, live estimates, and historical re-analysis.
The database gate rejects trade re-analysis before every pick refresh completes.
The full unit suite and quality checks run for this integration.
[Integration evidence](release-2.6-integration.md) records exact results and unverified areas.
