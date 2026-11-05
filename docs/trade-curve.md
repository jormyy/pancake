# Trade curve

`core/src/dynasty/tradeScoring.ts` owns the model version, exponent, and fairness tolerance.
The current model is `onenumber-trade-curve-v6`.
OneNumberHoops source values use a zero-to-1,000 scale.
Players and picks contribute `1000 * (value / 1000) ** 5` to package totals.
FAAB keeps its existing value.
There is no consolidation bonus or value for an open roster spot.

Each team keeps separate sent and received totals.
Net value equals received value minus sent value and required cuts.
The absolute package gap uses the larger absolute package total as its denominator.
A gap of at most five percent is Fair.
The higher net value identifies the winner.

All player locations count, including IR and taxi.
Picks and FAAB consume no player slots.
Saved incoming destinations and retained-player moves determine each resulting roster.
An overfull section loses the lowest curved values, including incumbent players.
Missing imported values contribute zero.

Refresh publishes the shared result without applying another curve.
Revaluation preserves original quotes and uses stored asset routes.
See [trade estimates](trade-estimates.md) and [roster legality](trade-legality.md).

## Verification

Run `tests/trade-curve.test.ts` and `tests/trade-scoring.test.ts` for arithmetic and roster terms.
Run `tests/db/trade-curve.sql` for the database result.
Run `tests/db/trade-estimate-reanalysis.sql` and `tests/db/trade-historical-revaluation.sql` for saved trades.
Use the [local stack](verification.md#local-stack) for database checks.
