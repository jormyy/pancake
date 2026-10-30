# Pre-tipoff pending-offer fix

The source baseline is release 2.13.1 `c5789474`, with 729 migrations through 05409.
The lane fix is `bf84d604`. Apply migration `20261214005500_pre_tipoff_member_failures.sql` before `lineup-optimizer`.
No frontend change is required. The older worker remains compatible with the additive SQL.

The historical pending-asset lineup guard raises PA004 while deleting an offered starter's lineup row.
Replaying that historical function in a rollback transaction reproduces the supplied lock path.
Main's complete schema already contains migration 025, which permits those slot changes.
Pending offers alone pass on main. Production's installed SQL was not inspected.
The migration reapplies that current slot guard. Roster removal, ownership, IR, taxi and accepted-trade protections stay.

The reproduced batch defect is separate: one member's roster-limit failure makes the whole dispatch fail.
Healthy member receipts commit, but HTTP 500 makes the work retry after 60 and 120 seconds.
The third attempt can fall outside the pre-tipoff window.
The failing test reproduces HTTP 500 after two healthy members finish on unchanged main.

Migration 055 adds nullable `lineup_tipoff_members.error` and the service-only
`public.record_pre_tipoff_lineup_failure` RPC.
A failure receipt checks the current member, dispatch revision, token and lease, and bounds the error to 4,000 characters.
The first terminal receipt wins. An unchanged revision skips recorded failures; new inputs permit another attempt.
The worker keeps saved member errors in its response and logs while completing the batch successfully.
Dispatch reads, finish errors, lease loss and failure-receipt write errors remain retryable.
Scheduled and manual optimizer paths keep their behavior.

| Case | Baseline | Fixed lane |
| --- | --- | --- |
| Healthy members, no offer | HTTP 200; three optimized | Same response bytes |
| Healthy members, pending offer | HTTP 200; three optimized | Same response bytes |
| Pending offers and one roster failure | HTTP 500; two optimized; failed work | HTTP 200; two optimized; saved member error; one successful work attempt |
| 103 members and one failure | Not measured | 103 receipts, 102 successes, one saved error, one work attempt |

The lane passes all four cases through the real handler and its local Edge runtime.
The SQL receipt test passes 18 checks. Trade-lock coverage passes 29 checks.
The concurrency recipe preserves receipts and settings locks through live-score overlap and retries.
The release integration reruns these focused proofs on `pt4bafableint`, Docker Desktop, ports `650xx`.
No production service, push, deployment, real email or push notification is used.

Two old fixtures also failed on the unmodified baseline.
The pre-tipoff fixture now supplies complete assignments and identifies the preserved starter by player ID.
The roster fixture permits a pending pick transfer and checks automatic offer expiry, as migration 029 requires.
The rejection, lock-preservation, accepted-trade and roster guards remain covered.

Use Node 22, PostgreSQL client 16 or newer, and local CLI keys from the owned stack:

```sh
export DOCKER_CONTEXT=desktop-linux
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:65022/postgres
export PANCAKE_TEST_DB_PORT=65022
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/pre-tipoff-member-failures.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-locks-drop-only.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-queue-pre-tipoff.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/roster-lifecycle-invariants.sql
node tests/e2e/pre-tipoff-live-concurrency-db.mjs
deno test --cached-only --node-modules-dir=manual --allow-env --allow-net=127.0.0.1,localhost supabase/functions/lineup-optimizer/preTipoff.test.ts
```

For `supabase/tests/db/pre-tipoff-trade-offer.ts`, set `SUPABASE_URL` to the owned local API,
`PANCAKE_SUPABASE_SECRET_KEY` to its local CLI service key, and `PANCAKE_EDGE_INTERNAL_TOKEN` to its local token.
Run `deno run --cached-only --node-modules-dir=manual --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/pre-tipoff-trade-offer.ts`.
Set `PRE_TIPOFF_EDGE_RUNTIME=1` to exercise a local Edge gateway serving the integrated worker.
The script removes its fixtures. Keep outputs outside Git.
[Release integration](release-2.14-integration.md) and [cleanup](release-2.14-cleanup.md) record the combined proof.
