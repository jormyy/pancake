# CDN participation and DNP corrections

The shared CDN stat writer uses the provider's explicit `played` field.
Both live stats sync and CDN backfill call this writer.

| Provider value | Stored `did_not_play` |
| --- | --- |
| `"0"` or `0` | `true`, regardless of minutes |
| `"1"` or `1` | `false`, including zero or missing minutes |
| Missing, null, or another value | Use the existing minutes fallback |

The fallback treats finite parsed minutes, including zero, as participation.
Missing, non-string, unparseable, or nonfinite minutes become null and indicate DNP.
Boolean and empty-string flags do not coerce to provider zero.
The writer preserves numeric stats and the existing minute rounding.
It does not erase a DNP player's raw stats.
Downstream scoring applies the existing DNP exclusion.

This corrects game-log status and the inputs to games-played counts, averages,
projections, and lineup scoring. It does not change text, layout, controls, or scoring coefficients.

## Existing rows and freshness

Deploying the writer does not rewrite existing rows.
A normal eligible stats sync compares `did_not_play` and upserts changed rows.
Recent Final games retain their existing 30-minute recheck window.
A completed backfill job retains its terminal ledger and does not replay completed games.
A new explicitly requested backfill can reread them through the corrected writer.
No bulk historical repair or production migration accompanies this change.

Season-average projections also depend on the existing analytics refresh schedule.
Correct source rows alone do not prove that every derived cache already refreshed.
Live and completed-game status, retry, permissions, job completion, and pacing remain unchanged.

## Verification scope

Two captured NBA Final games contain 69 stat rows, including 30 explicit DNP rows.
Interleaved local handler/API/database runs compare the original and corrected writer.
Controlled flag/minute mutations test malformed input and corrections in both directions.
These mutations are semantic tests, not new natural provider responses.
The checks preserve exact unaffected stats, fractional scoring, auth denial, retries,
concurrency, terminal ledgers, and freshness windows.
This is a correctness correction, not a speed claim or physical-device acceptance.
