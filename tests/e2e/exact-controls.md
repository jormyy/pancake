# Exact screen controls

Run this check on the assigned mini with the isolated local database.
The runner refuses API targets outside port 57121 and database targets outside port 57122.
It uses real local Auth, API handlers, and saved database rows.

| Input | Value |
| --- | --- |
| `E2E_SUPABASE_URL` | `http://127.0.0.1:57121` |
| `E2E_SUPABASE_PUBLISHABLE_KEY` | Public key from the assigned project CLI |
| `E2E_PANCAKE_SUPABASE_SECRET_KEY` | Service key from the assigned project CLI |
| `SUPABASE_DB_URL` | Local PostgreSQL URL on port 57122 |
| `EXACT_CONTROLS_RELEASE` | Complete local export with its original provenance |
| `EXACT_CONTROLS_OUTPUT` | New evidence directory |
| `EXACT_CONTROLS_PLAYWRIGHT` | Optional project Playwright module path |
| `EXACT_CONTROLS_ONLY` | Optional comma-separated case names |

Start the assigned local API first. Disable external push and email delivery.
Reserve web port 57198 for the runner.

```sh
node tests/e2e/exact-controls.mjs
```

The four case names are `home-auto-set`, `dense-row-accept`, `dense-row-reject`, and `pending-claim-taxi-edit`.
Use selected cases when another receipt already proves a control.

Home opens the manual editor from its auto-set sheet.
Saved lineup rows remain unchanged during navigation.
The locked lineup row must remain identical.

Trade controls come from the summary list beside the detail pane.
Acceptance retains ownership during the configured 24-hour member review.
Both offered players must remain reserved.
Rejection retains ownership and balances. History must show Rejected.

Roster edits an existing pending claim from regular placement to taxi placement.
The same claim must retain its bid, processing date, and pending state.
The existing edit rule refreshes its submission timestamp.
Reload must retain the flag. No player award occurs.

Each run creates fresh accounts, players, and one league with its own synthetic calendar.
Account passwords stay in memory. Receipts exclude keys and sessions.
Screenshots and SQL snapshots record each completed result.
Failed runs retain their completed cases without claiming overall success.

The runner closes its own browser and web server, then removes primary fixtures and change hints.
The caller must stop the API it starts and remove its environment file.
The caller must independently scan owned references, including JSON and text keys.
Remove owned score revision rows left after league deletion.
Confirm that owned Auth rows, outbox rows, hints, players, and calendar rows are absent.

This check covers local desktop Chromium. It does not prove settlement after review or scheduled claim processing.
It does not run CI, a full suite, production, or a release.
