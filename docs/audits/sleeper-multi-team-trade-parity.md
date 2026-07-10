# Sleeper multi-team trade parity

Verified against official Sleeper documentation on 2026-07-09:

- [How to Trade](https://support.sleeper.com/en/articles/3188802-how-to-trade)
- [Welcome to a New Trading Experience](https://support.sleeper.com/en/articles/4238825-welcome-to-a-new-trading-experience)
- [Sleeper API transaction model](https://docs.sleeper.com/)

## Multi-team transaction scope

| Sleeper behavior | Pancake implementation | Executable evidence | Status |
|---|---|---|---|
| Select multiple league mates for one proposal | Participant picker supports three or more league members and persists ordered `trade_participants` | `tests/e2e/browser-trade-multi-team.mjs`, `tests/e2e/multi-team-trade-db.mjs` | Match |
| Show every participating team while composing | Desktop uses parallel team panels; compact widths use a team overview plus sender tabs without hiding the other participants | `tests/e2e/browser-trade-multi-team.mjs` desktop/mobile captures | Match |
| Choose the destination team for each asset | Every player, pick, or FAAB item has explicit `from_member_id` and `to_member_id`; the composer exposes per-item destination controls | Browser proposal, edit, and counter route assertions; DB canonical-route tests | Match |
| Trade players | Routed roster-player items are validated and settled atomically | Multi-team release gate and DB settlement tests | Match |
| Trade current and future draft picks | Routed pick items preserve original-owner identity and transfer current ownership; browser coverage includes future picks | Multi-team browser/DB gates and future-pick trade scenarios | Match |
| Trade FAAB between teams | Routed FAAB items debit and credit the selected teams with aggregate balance checks | Multi-team release gate and DB aggregate-FAAB tests | Match |
| Require every party to accept | Each participant owns an acceptance timestamp; completion cannot begin until all required participants accept | Multi-team acceptance, concurrency, and authorization tests | Match |
| Apply an immediate or delayed review period | League veto mode/window controls immediate settlement or accepted-state review; due trades settle through the atomic processor | Trade-veto browser/backend scenarios and multi-team release gate | Match |
| Accept, decline, counter, edit, withdraw, and expire offers | Participant-aware lifecycle actions replace offers without mutating the prior version and enforce actor/status/expiry rules | Multi-team proposal/edit/counter browser scenario plus terminal and expiry tests | Match |
| Make routes understandable after submission | Offer cards group assets by receiving team, identify each sending team, and expose per-participant acceptance state | Multi-team browser offer captures | Match |

The parity claim above is deliberately limited to Sleeper's multi-team transaction workflow. It does
not claim that Pancake is a clone of the surrounding Sleeper product.

## Adjacent Trade Center features

| Sleeper feature | Pancake status |
|---|---|
| Active offers and trade history | Implemented |
| Player and draft-pick trade blocks | Implemented |
| Expiring offers and countdown state | Implemented |
| Full-league roster browsing | Available through the multi-team composer and team roster views |
| Trade-interest signals on assets owned by other managers | Not implemented; outside the multi-team transaction scope |
| Automatic trade-block posts and commissioner polls in league chat | Not implemented; Pancake has no equivalent league-chat surface |
| Commissioner force-through and reversal of completed trades | Not implemented; Pancake supports commissioner veto but intentionally does not claim parity for these moderation controls |

## Release gate

The multi-team parity gate must continue to prove all of the following in a real browser and replayed
database before release:

1. Three visible teams at desktop and compact widths.
2. A non-default destination route for at least one selected asset.
3. Player, future-pick, and FAAB persistence with exact sender and receiver identities.
4. Edit and counter flows preserving all participants while changing an individual route.
5. Per-participant acceptance followed by atomic settlement after the configured review window.
6. No horizontal page overflow, clipped primary action, console error, or failed network request at
   the supported viewport matrix.
