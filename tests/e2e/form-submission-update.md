# Local form submission and update proof

This runner uses the isolated local stack on ports 57121 and 57122.
The database must be `postgres` at `127.0.0.1:57122` with a PostgreSQL URL.
It creates disposable accounts and leagues, then removes them.
Run it on the assigned mini. Disable external email and push delivery first.
Start the local API before the runner. Leave shared services running.

## Inputs

| Variable                          | Value                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| `E2E_SUPABASE_URL`                | `http://127.0.0.1:57121`                                            |
| `E2E_SUPABASE_PUBLISHABLE_KEY`    | Local public key from the project CLI                               |
| `E2E_PANCAKE_SUPABASE_SECRET_KEY` | Local service key from the project CLI                              |
| `SUPABASE_DB_URL`                 | Local database URL on port 57122                                    |
| `FORM_SUBMISSIONS_BEFORE`         | Absolute path to a complete stamped baseline export                 |
| `FORM_SUBMISSIONS_AFTER`          | Absolute path to a complete stamped candidate export                |
| `FORM_SUBMISSIONS_OUTPUT`         | Absolute path to a new evidence directory                           |
| `FORM_SUBMISSIONS_PLAYWRIGHT`     | Optional Playwright module path; defaults to the project dependency |
| `SUBMISSIONS_ONLY`                | Optional comma-separated case names                                 |

The runner uses web port 57198. Reserve that port for this run.
The candidate must contain different application JavaScript. Changing release labels alone fails before fixture creation.
A full export with explicit `EXPO_PUBLIC_API_URL` can test a real local configuration change.
Both exports must use the same isolated authentication service.
Record source hashes and build settings beside the receipts.

## Execution

```sh
node tests/e2e/form-submission-update.mjs
```

Use `--check-sql-errors` to check local SQL failures without fixtures.

The nine cases cover sign-in, sign-up, password change, league creation, joining, settings, both overrides, and Profile team saving.
Each case uses one browser context and the visible submit control.
The runner holds an actual upstream response while the new worker waits.
Exact unsent input must survive before submission.
The old document must survive the pending request.
Saved values can arrive through live updates while the response waits.
A real sign-in rejection must permit correction and retry.
Password checks compare values only in memory. Receipts exclude passwords, tokens, and request bodies.

Independent database reads confirm saves. The server confirms the account after the update.
Profile and the selected membership confirm the current league.
All public and private application tables must stay unchanged during the completed update and later navigation.
Safe user, session, and identity fields track authentication changes separately.
Request counts detect repeated actions. Read-only RPC calls can also use POST.
The password case authenticates with the new password and rejects the previous password.

The runner closes only its own browser and web server.
The caller owns API shutdown and evidence copying.
This bounded proof does not replace native checks, full replay, performance review, or release approval.

## Create-league confirmation

Run with `SUBMISSIONS_ONLY=create-league` for this bounded check.
Both exports must include the code under test.
The runner publishes the complete update while the real creation response waits.
After release, the automatic reload must show “League created” and the saved invite code.
An independent SQL read confirms exactly one matching league and code.
The check fails before Profile navigation if this confirmation disappears.
It then checks manual reload, share cancellation and retry, account isolation, dismissal, and form cancellation.
The share API is intercepted at the operating-system boundary; no message is sent.
The previous selected membership and the server-verified account must remain correct.

Set `FORM_SUBMISSIONS_ENGINE=webkit` to use the installed Playwright WebKit engine.
Chromium is the default. Neither engine proves physical iPhone Safari or an installed PWA.
Set `FORM_SUBMISSIONS_LIVE` to a unique lowercase release-link name for an isolated source directory.

Set `FORM_CONFIRMATION_BLOCK_STORAGE=1` to reject only confirmation-storage writes.
The initial export must contain the fix.
The confirmation must hold the update until the user presses Done.
The waiting update must then reload within the existing timeout.
This proves storage failure cannot erase the code or hold updates after dismissal.

Cleanup scans every non-system table for owned identifiers, including JSON and array values.
It deletes only references to the disposable fixture identifiers.
The receipts record all scanned tables, removed references, and remaining references.
WebKit holds the actual browser fetch response before application code consumes it.
Chromium uses network routing. Neither path fabricates a server response.
The runner waits for React to own the form before entering input.
Cleanup records dependent memberships and seasons before league deletion.
It compares application and revision fingerprints with the state before fixture creation.

Set `FORM_CONFIRMATION_CANCEL_PENDING=1` to leave the form while its real response waits.
Creation still commits once upstream. The dismissed form must not save a stale confirmation.
The update must complete, and reopening Create League must show a fresh form.
