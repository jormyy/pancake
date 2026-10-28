# Historical release 2 verification

These checks pass on 2026-10-27 at source commit `80bd0cc3`.
This is a historical result, not the current release contract.
The [release 2.4 integration record](release-2.4-integration.md) supersedes its counts and migration head.

| Check | Result |
| --- | --- |
| Full `npx vitest run` | 3,771 passed, 0 failed, 33 skipped across 409 files. |
| `node --test 'scripts/season-sim/*.test.mjs'` | 305 passed, 0 failed, 0 skipped. |
| `npm run check:quality` | All 12 steps pass. |
| `npm run check:db-function-catalog` | Passes against the private migrated database. |
| `npm run check:database-types` | Passes against the same database. |
| `tests/db/linear-draft-order.sql` | Passes; the former ascending tiebreak fails the recipe. |
| `npm run test:db:release2-accept-capacity` | 30 assertions pass across both acceptance functions and all three roster groups. |
| `npm run test:db:release2-trade-activity` | 36 assertions pass across all nine transitions, identity payloads, duplicate protection and feed privacy. |
| `npm run test:db:release2-standings` | 11 assertions pass through the single dispatcher and refresh publication. |
| Existing activity feed recipe | 57 assertions pass. |
| WebKit at 390×844 | One vertical scroller; header, day strip and rows each move 420 pixels. |

The season suite contains 305 tests at this revision.
The full suite runs once after the functional changes.
The WebKit case runs separately on the mini; its Mac invocation skips.
The other 32 conditional skips remain unchanged.

Draft startup delegates to `generate_linear_draft_order`.
Tied records now use higher points per game before the stored seed.
The replay oracle and database fixture use different game counts to protect the rate comparison.

Roster acceptance already enforces the capacity limits.
The new recipe checks rejection without a legal plan and acceptance with the required drop.
Disabling validation makes the recipe fail.

Weekly finalization waits until the next Eastern date and settled game statistics.
Finalization marks the screen refresh queue dirty.
The single dispatcher runs each minute and queues `refresh-views`.
Standings change when that worker publishes its current claimed version.
Disabling its enqueue path makes the standings recipe fail.

The WebKit fixture uses the production score card, day selector and matchup rows.
The Home component test requires those sections inside one vertical scroller.

The private stack applies all 591 migrations through `20261112000200` in order.
The attestations retain the 329-migration audit baseline and the deployed 564-migration release 1 catalog.
Release 2 contains 27 pending migrations and 262 migrations after the audit baseline.
The deploy list includes all 21 affected Edge functions from the release runner's import graph.
The predecessor metadata uses the supplied release 1 commit and bundle digest.
No production endpoint is contacted.
The private stack is stopped after verification.
