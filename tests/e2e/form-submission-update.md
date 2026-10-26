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
