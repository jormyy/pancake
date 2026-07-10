# Sleeper multi-team trade parity

Verified against official Sleeper documentation on 2026-07-09:

- [How to Trade](https://support.sleeper.com/en/articles/3188802-how-to-trade)
- [Welcome to a New Trading Experience](https://support.sleeper.com/en/articles/4238825-welcome-to-a-new-trading-experience)
- [What are Sleeper's unique features?](https://support.sleeper.com/en/articles/1951583-what-are-sleeper-s-unique-features)
- [How do I force a trade through?](https://support.sleeper.com/en/articles/4033467-how-do-i-force-a-trade-through)
- [Basketball trading details](https://support.sleeper.com/en/articles/4702096-trading-details)
- [Sleeper API transaction model](https://docs.sleeper.com/)

Sleeper's public documentation establishes multiple trade partners, player/pick/FAAB assets,
all-party acceptance, offer lifecycle actions, review timing, and lazy roster enforcement. Its API
is read-only and exposes routed ownership fields, but it does not document every composer control or
post-submission visual treatment. Claims about those detailed UI choices are therefore Pancake
implementation evidence or compatibility inferences, not documented Sleeper equivalence.

## Multi-team transaction scope

| Behavior | Pancake implementation and evidence | Status |
|---|---|---|
| Select multiple league mates and require every party to accept | Ordered `trade_participants`; browser participant/acceptance scenarios; DB unanimous and concurrent-acceptance tests | Match |
| Route players, current/future picks, and FAAB between participants | Explicit `from_member_id` and `to_member_id`; browser route captures; DB ownership and aggregate-FAAB tests | Match |
| Show all teams and choose an asset destination while composing | Desktop/compact composer browser captures prove Pancake behavior. Official Sleeper text confirms multiple partners, but not this exact responsive UI | Compatible; exact UI parity inferred |
| Accept, decline, counter, edit, withdraw, and expire | Browser lifecycle scenarios cover user-visible actions; DB tests cover immutable replacements, authorization, and expiry | Match |
| Complete trades even when a recipient becomes over the active roster limit | Two-team and multi-team DB settlement tests; `tests/trade-lazy-roster-browser-contract.test.ts` proves the accept UI has no drop step | Match |
| While over limit, allow trades, drops, scoring, and eligible moves to IR/taxi | DB tests cover over-cap proposal/auto-consent, drops, IR, and taxi; static contract proves scoring functions have no cap gate | Match |
| While over limit, block free-agent acquisition and starting-lineup edits | DB tests call both user-authorized mutation paths; catalog/static tests require the lineup cap guard and preserve free-agent cap enforcement | Match |
| Keep submitted routes and consent understandable | Pancake offer cards group receiving/sending teams and show participant consent in browser captures. Official docs do not specify the same card layout | Pancake extension |

The roster-limit rule is lazy, not a delayed validation failure. Trade acceptance and settlement do
not reserve or drop players and do not reject an over-cap result. The affected owner remains able to
reduce the active count, trade, and accrue points from an already-set lineup, but cannot add a free
agent or mutate the starting lineup until the count is at or below the configured limit.

## Review governance and timing

| Topic | Sleeper | Pancake | Status |
|---|---|---|---|
| Immediate or delayed review | Supports immediate processing or a review period | `disabled`, `commissioner`, and `member_vote` modes with a configurable window | Capability match |
| Who can stop a reviewed trade | Official docs describe commissioner denial/force-through; native veto voting is unsupported and chat polls are advisory | Commissioner veto or binding member vote, depending on league mode | Governance differs |
| Delayed processing time | Official trade guidance says accepted delayed trades process at midnight Pacific | Due-trade processor runs on the configured five-minute schedule after the window | Timing differs |

Pancake therefore does not claim exact Sleeper parity for review governance or processing cadence.

## Adjacent Trade Center features

| Feature | Pancake status |
|---|---|
| Active offers, history, expiration, player blocks, and draft-pick blocks | Implemented |
| Full-league roster browsing | Implemented through composer and team-roster views |
| Trade-interest signals on another manager's assets | Not implemented |
| Automatic trade-block chat posts and advisory commissioner polls | Not implemented; no equivalent league-chat surface |
| Commissioner force-through or reversal of completed trades | Not implemented; commissioner veto is a different control |

## Evidence boundary

Browser evidence proves visible teams, compact/desktop composition, destination controls, offer
presentation, lifecycle controls, and participant acceptance flows. It does not prove transactional
atomicity, cap enforcement, or lock ordering.

Database evidence proves exact sender/receiver persistence, all-party consent, over-cap settlement,
lazy action restrictions, FAAB balance safety, asset collision serialization, and terminal failure
handling. Static/catalog evidence proves the browser accept contract has no eager-drop workflow, the
obsolete reservation schema is absent, and only lineup mutation entrypoints receive the cap guard.
