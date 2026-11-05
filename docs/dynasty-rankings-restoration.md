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
