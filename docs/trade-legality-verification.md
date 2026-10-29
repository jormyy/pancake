# Trade legality verification

Incoming IR and taxi choices execute after review with both saved roster plans.
Cancellation during review leaves both rosters unchanged and releases the reserved terms.

## Incoming placements and cancellation

The focused recipe is [trade-incoming-destinations.sql](../tests/db/trade-incoming-destinations.sql).
It passes 54 checks against the private stack.
The existing structured-reason recipe still passes 45 checks.
The focused UI and API tests pass 44 checks across four files.

Each incoming-placement fixture has two Regular slots, two IR slots, and two taxi slots.
The recipient sends a player from IR and fills the second Regular slot before acceptance.
The incoming player then needs an IR or taxi destination.
The browser selects that destination in the acceptance preview.
The database keeps both rosters unchanged during the 24-hour review window.
Execution applies both saved plans together.

The sender saves a drop, a retained IR move, a retained taxi move, and an incoming destination.
The IR case places the sender's incoming player into IR.
The taxi case places the sender's incoming player onto taxi.
The recipe checks both final rosters with the SQL legality function.

The recipe rejects a healthy incoming player on IR and a veteran on taxi.
The preview disables both choices and shows the exact SQL explanation.
It names the required injury designation and the taxi career-game rule.

The cancellation recipe checks proposer identity and the review deadline.
Cancellation preserves both rosters and releases player, pick, drop, move, and FAAB reservations.
The same assets and plans can then be offered again.
Early execution and execution after cancellation both fail.

Run this focused proof on the private mini stack:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-incoming-destinations.sql
E2E_TRADE_INCOMING_DESTINATIONS=1 node tests/e2e/trade-legality-browser.mjs
```

Run these focused component and API tests with Node 22:

```sh
npx vitest run tests/trade-accept-legality.test.ts tests/trade-roster-plan.test.ts tests/hooks/trade-actions.test.ts tests/trade-api-routes.test.ts
```

### IR acceptance states

| Step | Screenshot at 390 pixels |
| --- | --- |
| Sender saves all four choices | [Sender plan](/tmp/fable-c2-evidence/acceptance/ir-01-sender-plan.png) |
| Acceptance needs one Regular slot | [Blocked preview](/tmp/fable-c2-evidence/acceptance/ir-02-accept-needs-placement.png) |
| Acceptor assigns the incoming player to IR | [IR choice](/tmp/fable-c2-evidence/acceptance/ir-04-incoming-slot-ready.png) |
| Both plans wait for review | [Review window](/tmp/fable-c2-evidence/acceptance/ir-05-review-window.png) |
| Incoming player lands in IR | [Recipient roster](/tmp/fable-c2-evidence/acceptance/ir-06-incoming-slot-executed.png) |
| Sender's incoming and retained players land in IR | [Sender IR roster](/tmp/fable-c2-evidence/acceptance/ir-07-sender-moves-executed.png) |
| Sender's retained taxi move executes | [Sender taxi roster](/tmp/fable-c2-evidence/acceptance/ir-08-sender-taxi-executed.png) |

### Taxi acceptance states

| Step | Screenshot at 390 pixels |
| --- | --- |
| Sender saves all four choices | [Sender plan](/tmp/fable-c2-evidence/acceptance/taxi-01-sender-plan.png) |
| Acceptance needs one Regular slot | [Blocked preview](/tmp/fable-c2-evidence/acceptance/taxi-02-accept-needs-placement.png) |
| Acceptor assigns the incoming player to taxi | [Taxi choice](/tmp/fable-c2-evidence/acceptance/taxi-04-incoming-slot-ready.png) |
| Both plans wait for review | [Review window](/tmp/fable-c2-evidence/acceptance/taxi-05-review-window.png) |
| Incoming player lands on taxi | [Recipient roster](/tmp/fable-c2-evidence/acceptance/taxi-06-incoming-slot-executed.png) |
| Sender's retained IR move executes | [Sender IR roster](/tmp/fable-c2-evidence/acceptance/taxi-07-sender-moves-executed.png) |
| Sender's incoming and retained players land on taxi | [Sender taxi roster](/tmp/fable-c2-evidence/acceptance/taxi-08-sender-taxi-executed.png) |

### Eligibility and cancellation states

| Step | Screenshot at 390 pixels |
| --- | --- |
| Sender saves the plan | [Sender plan](/tmp/fable-c2-evidence/acceptance/cancel-01-sender-plan.png) |
| Acceptance needs one Regular slot | [Blocked preview](/tmp/fable-c2-evidence/acceptance/cancel-02-accept-needs-placement.png) |
| Ineligible IR and taxi choices show SQL explanations | [Disabled choices](/tmp/fable-c2-evidence/acceptance/cancel-03-ineligible-ir-and-taxi.png) |
| Restored eligibility permits IR | [Legal preview](/tmp/fable-c2-evidence/acceptance/cancel-04-incoming-slot-ready.png) |
| Both plans wait for review | [Review window](/tmp/fable-c2-evidence/acceptance/cancel-05-review-window.png) |
| Proposer confirms cancellation | [Confirmation](/tmp/fable-c2-evidence/acceptance/cancel-cancel-confirmation.png) |
| Cancellation succeeds before the list refreshes | [Saved cancellation](/tmp/fable-c2-evidence/acceptance/cancel-cancellation-saved.png) |
| Proposer cancels during review | [Withdrawn trade](/tmp/fable-c2-evidence/acceptance/cancel-06-cancelled-during-review.png) |
| Sender retains the planned drop and unmoved players | [Sender roster](/tmp/fable-c2-evidence/acceptance/cancel-07-sender-moves-unapplied.png) |
| Recipient keeps the original roster | [Recipient roster](/tmp/fable-c2-evidence/acceptance/cancel-08-recipient-unchanged.png) |
| The same assets and plans can be offered again | [Released terms](/tmp/fable-c2-evidence/acceptance/cancel-09-released-terms-reoffered.png) |

The WebKit run uses a 390 by 844 phone viewport and captures 25 states.
The cancellation test opens History directly after login.
Cancellation checks its own request state and the SQL response.
It does not depend on loading the separate offers feed.

The first component test fails because disabled IR and taxi choices have no explanation.
The first cancellation recipe fails because accepted trades cannot be withdrawn.
The first direct-History browser check fails because the offers feed disables its cancellation button.
These failures are reproduced before their fixes.

## Earlier verification

| Check | Result |
| --- | --- |
| Focused Vitest checks | 137 pass across nine files |
| Structured SQL recipe | 45 checks pass, including context forgery and late-failure rollback |
| Production-shaped audit | Justin has 20 Regular players; trading Jimmy Butler III from IR adds one excess Regular player |
| WebKit phone flow | Pass at 390 pixels; nine states captured |
| Taxi terms | The browser saves and executes both incoming and retained-player taxi moves |
| Acceptance | Both plans remain unapplied during review |
| Changed eligibility | Execution holds the trade and queues notices for both managers |
| Final roster | The browser confirms the repaired trade's resulting roster |
| Taxi regression checks | 13 acquisition checks and the game-lock deferral recipe pass |
| Quality checks | Lint, types, generated sources, boundaries, and design checks pass |

The private stack and test servers are stopped.
The copied schema and data files are deleted.

The test first fails against the old SQL because structured reasons are absent.
The parser test first fails because it discards a saved taxi move.
The copied-data audit confirms that a concrete retained-player drop fixes Justin's roster.

## Executor exception

The executor sets `pancake.applied_trade_id` to the accepted trade ID during execution.
The guard also requires a private player proof from the same database transaction.
The proof must name that trade, member, and player.
The destination must match the saved terms.

The SQL recipe rejects ordinary writes, a forged setting, a missing context, and a mismatched trade ID.
It rejects a roster move absent from the terms.
Authenticated users cannot write private proof rows.
A forced failure after drops and moves restores every roster row and clears the executor context.
A successful execution also restores the prior context.

The pending-lock lane can add its lock checks around this existing exception.
No new pending lock is part of this change.

## Commands

Run these Node checks on the Mac with Node 22:

```sh
npx vitest run tests/trade-accept-legality.test.ts tests/app/propose-trade-ownership.test.ts tests/trade-legality-step.test.ts tests/trade-roster-plan.test.ts tests/trade-api-routes.test.ts tests/lib/trades-read.test.ts tests/lib/trade-composer.test.ts tests/hooks/trade-actions.test.ts tests/trade-builder-terms.test.ts
npm run check:quality
```

Run these checks only against the private stack on the mini:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-structured-legality.sql
node tests/e2e/trade-legality-browser.mjs
```

## Screenshots

- [Invalid submission with the draft intact](/tmp/fable-c2-evidence/01-invalid-submit-draft-intact.png)
- [Sender's saved plan](/tmp/fable-c2-evidence/02-sender-plan-ready.png)
- [IR problem during acceptance](/tmp/fable-c2-evidence/03-accept-needs-ir-fix.png)
- [Repaired acceptance preview](/tmp/fable-c2-evidence/04-accept-plan-ready.png)
- [Accepted trade waiting for review](/tmp/fable-c2-evidence/05-accepted-awaiting-review.png)
- [Execution needs attention](/tmp/fable-c2-evidence/06-execution-held.png)
- [Resulting roster](/tmp/fable-c2-evidence/07-executed-roster.png)
- [Incoming player assigned to taxi](/tmp/fable-c2-evidence/08-incoming-taxi-destination.png)

- [Retained and incoming taxi players after execution](/tmp/fable-c2-evidence/09-retained-and-incoming-taxi-executed.png)
