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
