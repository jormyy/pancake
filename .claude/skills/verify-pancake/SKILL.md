---
name: verify-pancake
description: Verify Pancake’s real web PWA with an isolated local database, seeded users, iPhone-sized browser journeys, screenshots, and stored-state evidence.
---

# Verify Pancake

Prove the requested behavior through the real UI and confirm its stored result.
Read [the feature map](features/README.md) before choosing journeys.
Complete every entry point named in the selected journey, or report the unmet precondition.

## Launch

Use Node 22, Docker, Supabase CLI, a PostgreSQL client, and the installed `agent-browser` CLI.
Install the existing lockfile with `npm ci --ignore-scripts --no-audit --no-fund` if dependencies are absent.
The helper refuses other Node versions.

```sh
tools/verify/launch.sh
```

Optionally pass a new absolute evidence directory outside the checkout.
The default is `~/Documents/pancake-verify-evidence/<run-id>/`.
Copy that printed path into `EVIDENCE` for the remaining commands.
Use the filesystem's canonical path and letter case for the evidence directory.
On macOS, a differently cased parent path can break Metro's workspace package resolution.
Resolve the existing parent with `pwd -P` before choosing the new directory.

```sh
EVIDENCE='/absolute/path/printed/by/launch'
BROWSER() { tools/verify/browser.sh "$EVIDENCE" "$@"; }
tools/verify/doctor.sh "$EVIDENCE"
tools/verify/browser.sh "$EVIDENCE" login
tools/verify/browser.sh "$EVIDENCE" snapshot -i
```

Wait for `READY`, then require Home to show the seeded team after login.
`READY` proves stack, fixtures, build, and read-only health; the UI login proves authentication in the exported app.
Credentials come only from the generated `work/tests/e2e-state.json`.
The login helper reads that file and types into the real sign-in form.
Never inject sessions, replace app requests, or use saved user profiles.

The helper copies tracked app sources into the evidence directory and exports the real release build there.
Its copied `supabase/config.toml` has a unique project ID and unused port block.
The checkout’s config stays unchanged, so no config restoration is needed.
It disables scheduled jobs in that disposable database to prevent external ingestion.
Functions receive only generated local values; no private environment files are read.
Never use hosted databases, hosted Edge functions, production builds, or the user's browsers.

## Doctor

```sh
tools/verify/doctor.sh "$EVIDENCE"
```

Run this read-only check whenever the UI looks wrong.
It checks process ownership, local endpoints, build revision, migrated schema, authentication health, and fixture identity.
It cannot substitute for visible sign-in or a feature journey.
Read that run’s logs after a failure; never borrow another run’s stack.

## Drive

```sh
tools/verify/browser.sh "$EVIDENCE" set viewport 390 844
tools/verify/browser.sh "$EVIDENCE" snapshot -i
tools/verify/browser.sh "$EVIDENCE" click '[aria-label="Open auto-set lineup options"]'
tools/verify/browser.sh "$EVIDENCE" screenshot "$EVIDENCE/action.png"
tools/verify/browser.sh "$EVIDENCE" find role button click --name 'Edit lineup manually' --exact
tools/verify/browser.sh "$EVIDENCE" snapshot -i
```

The wrapper always supplies a unique `--session` and a private headless browser configuration.
Use fresh snapshot references after each navigation or state change.
The wrapper resolves exact role clicks from visible snapshots because hidden screens can contain duplicate controls.
Use `eval` only to observe rendered state, geometry, or browser capabilities.
Never invoke app mutations from `eval`, database writes, or hidden test endpoints as journey proof.
Read fixture IDs and dates from `fixture.json`; do not guess them.

Repeat selected journeys at 375×812 and save separate screenshots.
Check document overflow and inspect every screenshot before calling the layout sound.
Chromium at iPhone size does not prove iOS Safari or home-screen standalone behavior.
Report physical iPhone installation, safe areas, keyboard, push permissions, and standalone lifecycle as unverified until tested there.

## Evidence

Capture the UI before the action, the action’s selected state, and the final visible result.
Save snapshots and screenshots under `EVIDENCE`, with the feature ID and viewport in each filename.
Keep the login form’s populated password and private environment values out of screenshots and reports.
The wrapper records action names in `actions.log` without form values.

```sh
tools/verify/browser.sh "$EVIDENCE" snapshot > "$EVIDENCE/home-390.txt"
tools/verify/browser.sh "$EVIDENCE" screenshot "$EVIDENCE/home-390.png"
node tools/verify/observe.mjs "$EVIDENCE" > "$EVIDENCE/database-before.json"
```

After a mutation, repeat the database observation into `database-after.json`.
For Start, require a `lineup_player_pins` row with `pin=start` and a matching starter in `weekly_lineups`.
Return to Home and reopen Lineup to confirm persistence through the UI.
An accepted click, successful toast, or screenshot alone does not prove persistence.
Do not report a missing fixture, skipped entry point, or broken journey as a pass.

## Cleanup

```sh
tools/verify/cleanup.sh "$EVIDENCE"
test -s "$EVIDENCE/home-390.png"
test -s "$EVIDENCE/database-after.json"
agent-browser session list
```

Cleanup closes only this run’s browser, terminates recorded child processes, and stops its unique Supabase stack without backup.
Evidence survives cleanup, including failed-run logs.
Launch automatically cleans up after setup failure.
After interruption, call cleanup yourself before restarting.
Do not delete other stacks, Docker volumes, profiles, or browser sessions.

## Helpers

See [helper reference](../../../tools/verify/README.md) for commands and known setup limits.
`launch.sh` creates the instance; `doctor.sh` checks it; `browser.sh` drives it; `observe.mjs` reads stored state; `cleanup.sh` removes runtime resources.
Update this map when behavior changes, using `/maintain-verification-skill` when that skill is available.

## WebKit

Use the installed Playwright WebKit browser for desktop and iPhone-sized web verification.
Login creates a touch context at mobile widths; its control actions use taps.
At desktop width, login creates a desktop context and control actions use clicks.
This path proves WebKit, not physical iOS Safari or an installed PWA.
Install the lockfile's browsers with `npx playwright install webkit chromium` if the browser executables are missing.

```sh
node tools/verify/run.mjs webkit "$EVIDENCE"
node tools/verify/webkit.mjs "$EVIDENCE" login 0
node tools/verify/webkit.mjs "$EVIDENCE" viewport 390 844
node tools/verify/webkit.mjs "$EVIDENCE" snapshot
node tools/verify/webkit.mjs "$EVIDENCE" click '{"role":"button","name":"Propose trade"}'
node tools/verify/webkit.mjs "$EVIDENCE" observe
node tools/verify/webkit.mjs "$EVIDENCE" capture trade-player-stats-390
```

Start WebKit once per run; wait for `webkit-port.json` and inspect `webkit.log` if startup fails.
Use `click` with an exact role/name or a visible CSS selector.
Use `fill` with a JSON target and value, `focus` with a target, and `key` with a Playwright key name.
`back` invokes browser Back; also exercise the visible Back control in player pages.
`observe` reads visible controls, both scroll axes, nested controls, overflow, focus, and the URL.
`capture` writes the real screenshot and accessibility snapshot outside the checkout.
The run records the WebKit process identity; normal cleanup stops it and keeps captures.
Repeat the full selected journey at 375×812 and 1440×1000.

An admitted remote host may use an existing local Docker socket.
Set `PANCAKE_VERIFY_DOCKER_HOST=unix:///absolute/path/docker.sock` on launch, doctor, and cleanup.
Only a Unix socket is accepted; generated app endpoints remain on loopback.
Keep each run's source copy and evidence on that host, and copy public proof files back after cleanup.

After a source edit, run `node tools/verify/run.mjs rebuild "$EVIDENCE"` to refresh this owned instance.
This copies app code, exports the current revision, reapplies enrichment, and repeats doctor.
It retains the isolated database and does not copy environment files.
Run `node tools/verify/run.mjs webkit "$EVIDENCE"` again to replace only this run's browser context.
Run the full matrix with `node tools/verify/run.mjs trade-player-stats "$EVIDENCE"`; its log stays with the evidence.

After cleanup, require these trade proof files to remain:

```sh
test -s "$EVIDENCE/trade-player-stats-all-receipt.json"
test -s "$EVIDENCE/webkit-trade-player-stats-375-propose-name-back.png"
test -s "$EVIDENCE/webkit-trade-player-stats-1440-accept-roster-plan-back.png"
```

## Dynasty pick calendar-year repair

Use the `dynasty-pick-calendar-years` journey in [League](features/league.md) for the guarded data repair.
The normal launch applies the current schema, then `pick-years.mjs prepare` creates the legacy wrong-year fixture.
Provide the approved filtered before-snapshot and reviewed external rollback file explicitly.
`apply` handles both an ordered upgrade and a current-schema fresh fixture; it never targets a hosted database.
Run its reconciliation, drift refusal, repeat, rollback and focused recipe checks before the visible Picks journey.
Keep data snapshots, migration receipts and both All/Traded screenshots after cleanup.

## Multi-team partial acceptance

Use the `trade-offers` journey in [Trades](features/trades.md) with a three-team offer.
The fixture teams map to the real case: Team 1 is Kyle (proposer), Team 2 is Matt, Team 3 is Jet (full roster).
`BROWSER login <n>` takes a zero-based index: `login 1` is E2E Team 2 and `login 2` is E2E Team 3; confirm the team name in the snapshot.
Seed the offer with `node tools/verify/seed-trade-acceptance.mjs "$EVIDENCE" --full='E2E Team 3' --mode=net-plus-one --plan=none`.
The seed sets `leagues.roster_size` to Team 3's player count, so the limit equals the roster size and Team 3 starts full.
Read the real limit and counts from the database, not from the offer text.

Prove the failure first on the unfixed stack.
Sign in as Team 2, open the offer, tap Accept, then poll the page text for `over the limit` every 125 ms and screenshot on the first match.
The toast is transient; a screenshot two seconds later misses it.
Expect the 409 body in the response log and an unaccepted participant in `trade_participants`.

Repeat the journey on the fixed stack.
Team 2 accepts while Team 3 is full; the API returns 200 and `trade_participants.accepted_at` is set.
Team 3 then opens the offer, picks a drop, and accepts; the trade status becomes `accepted`.
Read the drop back from `trade_participants.drop_player_ids`, not from the radio label after the click, because the row moves between sections and the list order changes.

An over-limit last acceptance never reaches the server from the app.
The client disables Accept and shows `Invalid roster • 1 over roster limit (17/16)`.
Prove the server rule with a direct call: POST `$E2E_API_BASE_URL/trades/<id>/accept` with the participant token,
body `{"memberId":"<full team>","dropPlayerIds":[],"rosterMoves":[]}`, and an `x-request-id` header.
Expect 409 `E2E Team N: Regular roster is 1 over the limit of <size>` and an unchanged trade.

Complete through the Edge route the app uses:
`curl -X POST "$E2E_SUPABASE_URL/functions/v1/process-trades" -H "x-internal-function-token: $PANCAKE_EDGE_INTERNAL_TOKEN"`.
The isolated stack has no cron, so nothing else calls it.
Record `node tools/verify/observe.mjs "$EVIDENCE"` before and after, and require the incoming player on the receiving roster, the dropped player gone, and each team's `faab_balances.balance` changed by the traded amount.

Run the database recipes first: `npm run test:db:trade-acceptance-multi-team` and `npm run test:db:trade-acceptance-concurrency`.
Both fail on the pre-fix `private.accept_trade_participant_atomic` and pass on the scoped one.
