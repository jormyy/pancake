# League

League provides standings, schedule, activity, draft tools, picks, settings, and season history.

## Sub-features

- `league-standings` shows team positions and opens team rosters.
- `league-schedule` shows weekly matchups and opens matchup details.
- `league-past-scores` shows every team's stored total through a past matchup's Other matchups strip.
- `league-activity` shows public league events and pagination.
- `league-settings` shows rules, invite code, waiver order, and commissioner controls.
- `league-picks` shows future pick ownership.
- `dynasty-pick-calendar-years` repairs the approved legacy pick years and preserves traded ownership and frozen references.
- `league-bracket` shows playoff matchups.
- `league-history` shows completed Pancake seasons, final standings, and season statistics.

## How to get to it (user POV)

- Select League from main navigation, then its section tabs.
- Select a team in Standings or a matchup in Schedule.
- Settings → bracket or commissioner settings.
- History → the completed season named in `fixture.json`.
- For `dynasty-pick-calendar-years`, switch to Draft year verification, then select League → Picks → All and Traded.

## Driving it with agent-browser

Preconditions:

- Require the active league and current matchup. History requires a completed Pancake season with final standings and statistics.

- **Standings.** Select League and snapshot `League sections`. Select Standings and require all seeded teams. Select the opponent and compare its roster.
- **Schedule.** Select Schedule. Open the current week’s matchup and require both teams, date range, scores, and day controls.
- **Past scores.** Select Schedule, then a completed week. Scroll to Other matchups and swipe through every team. Compare totals with stored matchups. Open another team's card. Return to Schedule and repeat with a different completed week.
- **Activity.** Select Activity. Read the visible events and exercise Load more when present. Compare their order and contents with stored transactions.
- **Settings.** Select Settings. Require rules, invite code, and waiver order. Open commissioner controls as the owner, change one reversible setting, save, reopen, and compare stored league settings.
- **Picks and bracket.** Select Picks and confirm future ownership against stored picks. Open Bracket from Settings and follow a matchup.
- **History.** Select History and require the `pastSeasonYear` from `fixture.json`. Open it and compare final positions and statistics with `fixture.json.history`. Require Team 2 as champion, Team 1 as runner-up, two games, and 420 total points.
- **Widths.** At 375×812 scroll the section row and confirm every section remains reachable.

### Dynasty pick calendar years

Use a disposable stack and the filtered before-snapshot supplied for the approved repair.
It contains league, pick and member UUIDs, years, rounds and usage state, with no production users or personal data.
Never restore a production backup or borrow production credentials for this journey.

```sh
node tools/verify/pick-years.mjs "$EVIDENCE" prepare "$FILTERED_PICK_BEFORE"
node tools/verify/pick-years.mjs "$EVIDENCE" apply
node tools/verify/pick-years.mjs "$EVIDENCE" rollback "$REVIEWED_PICK_ROLLBACK"
node tools/verify/pick-years.mjs "$EVIDENCE" check
node tools/verify/run.mjs rebuild "$EVIDENCE"
node tools/verify/run.mjs webkit "$EVIDENCE"
node tools/verify/pick-years.mjs "$EVIDENCE" drive after
```

Preparation creates 150 deliberately wrong-year picks using the approved UUID identities and synthetic local users.
Seven real fixture trades reproduce the existing ownership differences.
If the stack has no other league, preparation adds an unrelated sentinel league so the missing-target refusal and other-league preservation have real data.
A frozen quote, nested history snapshot, block listing and value cache exercise dependent state.
The helper refuses an existing target fixture and any database except the recorded loopback instance.

`apply` first removes the target inside a rolled-back transaction and requires a populated database to refuse the missing target.
It then changes one local pick year inside another rolled-back transaction and requires the exact-state guard to refuse the drift.
Both probes roll back even if the expected refusal fails. It applies the pending migration or replays its repair on a fresh install, and checks every row.
Require 150 shifts by exactly one year, seven unchanged traded owners, identical other pick columns, identical trade/block identities, corrected numeric pick references, explicit calendar-convention markers on repaired frozen inputs, and unchanged root season years and saved labels.
A second execution must produce identical state and the same receipt timestamp.
Quote and history table locks drain existing writers during cutover. Permanent write guards lock referenced picks and reject delayed quote/history inputs whose pick years no longer match storage.
The writer-fence recipe retains pre-repair inputs, shifts a local pick, rejects delayed save and direct quote/history writes, and accepts refreshed inputs.
`rollback` tests the reviewed external reverse SQL, requires restored picks and frozen references, then reapplies the candidate.
It removes the newly added convention markers as it restores the exact before-state, and leaves derived caches expired for safe regeneration.

`check` runs the calendar-boundary, generation, rollover, rookie, trade-window, valuation and related recipe tests against this owned stack.
Its external execution copies replace the old fixed API port with this run's loopback endpoint and resolve recipe includes to the checkout.
It also runs the focused frozen-valuation Edge tests.
Run `node tools/verify/pick-years.mjs "$EVIDENCE" harness` for the opt-in database-backed future-pick chain, invariant and lifecycle test; its local API configuration comes only from this generated run.

`drive after` signs in through visible controls in WebKit at 390×844, 375×812 and 1440×1000.
It selects the fixture league, opens Picks, selects All, and requires the full 2027–2031 window.
Traded must contain all seven expected original/current owners with their corrected years.
The journey saves screenshots, accessibility snapshots and viewport receipts.
Phone widths use touch; desktop uses mouse input.

An ordered upgrade can additionally run `drive before` before applying the migration.
Its old application and database must show all 150 picks in 2028–2032.
A current-head fresh installation already uses the corrected window, so use the stored before-state for that precondition instead of crediting an old-source screenshot as final-head proof.

Keep `pick-years-before.json`, `pick-years-after.json`, `pick-years-repeat.json`, `pick-years-rollback.json`, `pick-years-restored-candidate.json`, `pick-years-migration-receipt.json`, recipe logs and the after-UI receipt.
Run normal cleanup and prove those files and screenshots survive unchanged.
Run `node tools/verify/pick-years.mjs "$EVIDENCE" catalog` on both instances and compare their `pick-years-security-catalog.json` files.
After they match, run `node tools/verify/pick-years.mjs "$EVIDENCE" attest` on the fresh instance to regenerate the required repository attestations from its local database.

A missing filtered snapshot or reviewed rollback is a failed precondition, not a skipped proof.
The fixed repair accepts only its recorded league and exact before-state; do not weaken its guard to fit another fixture.
Production application, live reconciliation and release remain supervisor actions.

## Gotchas

- Activity shows transactions. History shows completed Pancake seasons.
- Require `completedPastSeason: true` and the matching final matchup before testing History.
- No playoff fixture means bracket population remains unverified.
- Do not count imported non-Pancake seasons as eligible history.


After the pick-year journey, run normal cleanup and require the proof files to remain:

```sh
tools/verify/cleanup.sh "$EVIDENCE"
test -s "$EVIDENCE/pick-years-migration-receipt.json"
test -s "$EVIDENCE/pick-years-repeat.json"
test -s "$EVIDENCE/pick-years-rollback.json"
test -s "$EVIDENCE/pick-years-ui-after-receipt.json"
test -s "$EVIDENCE/webkit-pick-years-after-375-traded.png"
```
