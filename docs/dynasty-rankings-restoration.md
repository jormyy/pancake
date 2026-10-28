# Hashtag rankings and trade values

Hashtag Basketball supplies ranking screens again.
OneNumberHoops supplies trade values only.

## Readers

| Reader | Source and result |
| --- | --- |
| `get_dynasty_forecast_inputs` | Hashtag five-year ranks, three-year ranks, and rookie ranks. League averages and projections stay separate. |
| `useDynastyRankings` | Hashtag forecast order and rookie order. The original player weights and pick curve supply display values. |
| `view_player`, both overview and full responses | Hashtag five-year points, three-year points, and the shared Hashtag dynasty rank. |
| `PlayerHeader` | The player view supplies both point labels and the dynasty rank. |
| `view_draft_room`, both nomination and search results | Hashtag supplies ages. Shared player fields supply Hashtag ranks. |
| Player search, player lists, roster summaries, and draft order | Shared `players.dynasty_rank` fields now contain the Hashtag five-year rank. Their queries stay unchanged. |
| `get_dynasty_pick_values` | OneNumberHoops bands remain available for trade use. Ranking screens no longer call this reader. |
| `private.build_trade_estimate_inputs` and `get_trade_estimate_reanalysis_inputs` | A private reader overlays OneNumberHoops player values and source metadata onto frozen production inputs. Pick bands stay unchanged. |
| Trade scoring, trade details, saved estimates, and pick predictions | OneNumberHoops player values and pick bands. These readers stay unchanged. |

## Sync and stored rows

The worker, parser, matcher, forms, fixtures, and tests match the release 2.5 files exactly.
The scheduler wakes hourly.
The existing weekly keys prevent duplicate successful work for each view.
Monday work waits until 07:00 Eastern Time.
The worker writes three-year, rookie, then five-year rows.
Only the five-year write updates the shared player rank.

The migration restores shared ranks from retained Hashtag rows immediately.
It clears shared ranks for players with only a trade source rank.
Trade publication and match review no longer overwrite those fields.
The migration preserves OneNumberHoops rows and `dynasty_pick_values`.
New ranking cache keys discard saved results from the mixed sources.

## Pick curve

Release 2.4 uses fixed round bases of 680, 420, 250, and 140.
Slot weights range from 1.30 to 0.72.
Unknown slots use the rounded mean of the rounded endpoints.
Yearly discounts are 0.90 overall, 0.84 for contenders, and 0.95 for rebuilding.
Strategy factors are 1.00, 0.88, and 1.08.
The year uses the season ending year internally.
The display uses the calendar draft year.
A current-year first-round pick one season ahead returns 619, with a 441–796 range.
Hashtag supplies the rookie list; this original curve supplies future pick values.

## Verification

Run these checks against the private local stack.
The integration runner requires its configured private project and loopback ports.
Release 2.6.3 sets `HASHTAG_TEST_PROJECT=pt4bafabler263`, `PANCAKE_TEST_API_PORT=59221`, and `PANCAKE_TEST_DB_PORT=59222`.
It blocks outbound requests outside its fixture origin and local API.
The browser check needs the local frontend on port 59080 and the local Edge functions.

```sh
node tests/e2e/dynasty-ranking-rpc.mjs --browser
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/hashtag-ranking-restoration.sql
npx vitest run tests/hooks/dynasty-rankings-identity.test.ts tests/components/player/player-detail.test.ts tests/lib/dynasty-ranking-values.test.ts
```

The integration runner starts with 400 five-year, 400 three-year, and 52 rookie rows.
It also publishes 450 trade rows and 27 pick bands from the stored trade fixture.
It invokes the real sync handler for each Hashtag view.
It checks the authenticated player view route used by the player page.
It publishes trade values again and checks that shared Hashtag ranks stay unchanged.
The pick regression checks the current-year value without any stored trade bands.
The browser checks both point labels on desktop and phone layouts through the player page.
It checks a 2026 rookie pick while stored trade bands start in 2027.

The old writer fails the metadata check because it inserts no rows.
The old player view fails because it returns no five-year points.
The old ranking hook fails because the current-year pick returns zero.
An incorrect forecast label makes the browser check fail.
