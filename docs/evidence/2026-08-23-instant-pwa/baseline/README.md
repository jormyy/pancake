# Baseline

The local fixture has four managers, 64 players, 280 lineup rows, and 28 games.

The release build loads at every required viewport without horizontal overflow.

The cold authenticated home screen becomes ready in 2.34 seconds.

The budget allows one second.

The data gate fails because `search_players` reaches 137 milliseconds.

The request budget allows 100 milliseconds.

| Check | Result | Evidence |
| --- | --- | --- |
| Unit tests | 616 pass in 1.43 seconds | Test output recorded in `progress.json` |
| Quality checks | Pass in 15.91 seconds | Test output recorded in `progress.json` |
| Release export | Pass in 13.77 seconds | Bundle sizes recorded in `progress.json` |
| Release hydration | Pass | Final route is `/sign-up` |
| Viewports | Seven pass | `viewports.json` and matching images |
| Data budget | Fail | `search_players` exceeds 100 milliseconds |

The failed data gate proves that the budget can reject a slow query.

The first development load showed a stale Metro module overlay.

A clean release export did not show the overlay.
