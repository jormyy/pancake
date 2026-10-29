# Release 2.7.2 integration

## Integrated work

The release retains the existing scoped trade revaluation changes.
The trade redesign replays all 16 requested commits with their source records.
Schedule adds skipped weeks without opponents or scores.
Forecast includes its latest release-order documentation commit.
No SQL function changes overlap between these four lanes.
The release-order test retains both trade and refresh documentation sources.

## Migration order

The private rehearsal restores the supplied production-shaped backup.
All 683 migration fingerprints match the repository.
The four new migrations apply in this order:

| Migration | Change |
| --- | --- |
| `20261211000100` | Separate trade revaluation from screen refresh. |
| `20261211000200` | Show skipped schedule weeks. |
| `20261211000300` | Bound forecast history reads. |
| `20261211000400` | Restrict Taxi moves to eligible incoming players. |

The function catalog and both attestation files regenerate from the private database.

## Additional repairs

One stale assertion now expects only the viewer's roster status.
An unused forecast timing helper remains internal.
These repairs change verification code only.
The database fixtures retain inactive cron definitions and use only private endpoints.
The idle-dispatch fixture isolates existing league data inside its rollback transaction.

## Verification

| Check | Result |
| --- | --- |
| Focused Vitest runs | 1,162 pass; 3 optional cases skip. |
| Changed Edge functions | 2 entrypoints type-check; 18 tests pass. |
| `npm run check:quality` | Pass, including lint and all configured type checks. |
| SQL recipes | 38 pass, including every recipe changed by these lanes. |
| SQL failure controls | 4 deliberately broken variants fail as expected. |
| Forecast comparison | 11,760 calls; outputs match before and after. |
| Forecast timing | Revised maximum: 62.608 ms on one CPU. |
| Catalog and migration fingerprints | Pass through all 683 migrations. |
| Browser smoke at 390 px | Propose, accept, Schedule, and Matchup pass. |

The focused Vitest runs cover 39 files, including generated-artifact contracts.
The forecast comparison covers two dates and both custom and generic query plans.
It includes a live-game case and enforces the 300 ms percentile and one-second statement limits.
The latest test-scope instruction defers the full Vitest suite until before a push.

The browser confirms invalid states, repairs them, sends the trade, and records acceptance.
It checks skipped weeks, Daily Total, keyboard access, and horizontal overflow.
All four final screenshots pass visual review.
The browser uses one private origin for sign-in and API reads.

The verification commands use `npx vitest run`, `npm run check:quality`, Deno, and the repository SQL recipes.
No application code repair is needed beyond the merged changes.

The private stack stops with no cleanup errors.
The automation browser closes, and transferred backup copies are removed.
No production service, deployment, push, pull request, or CI run is used.
