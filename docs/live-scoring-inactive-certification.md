# Inactive players and final certification

`public.save_game_stats_atomic(uuid,text,jsonb,boolean)` removes absent inactive rows before its final coverage check.
The row must have `did_not_play=true`, zero minutes, and explicit zeros for every numeric stat.
Both double-double flags must be false.
Null values, played rows, and nonzero values still fail the coverage check.
Live imports skip players whose box-score status is `INACTIVE`.
Final imports keep every supplied player.

Cleanup, stat writes, final certification, and the cleanup receipt share one database transaction.
A failure rolls back all four.
The integer result still counts inserted and updated rows.
Each cleanup writes a successful `sync_runs` receipt named `sync-stats:inactive-cleanup`.
Its `details` contain `game_id`, `nba_game_id`, and the complete `removed_inactive_rows`.
An unchanged revision creates no duplicate receipt.

## Stats certification release order

Apply `20261210000200` before updating Edge.
The migration adds the cleanup receipt field and replaces `public.save_game_stats_atomic`.
It preserves the existing RPC arguments and return value.
The release reaches 676 migrations.
Its ordered pending set contains 48 migrations.

## Local proof

Use the private stack with project ID `pt4bafablecg` and database port `61022`.
Run Docker and Deno checks on the Mac mini.
Apply migration `20261210000200_certify_inactive_zero_rows.sql` through the local migration workflow.

```sh
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:61022/postgres
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/stats-certification-inactive.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/game-stats-completion.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/final-stat-revisions.sql
deno test --allow-env --allow-net --allow-read --allow-run=psql supabase/functions/_shared/syncStats.certification.test.ts supabase/functions/_shared/syncStats.inactive.test.ts
```

The backup predates tipoff for `0022600142`.
The saved fixture preserves its game and player identities.
The test reconstructs first-quarter rows and a zero-stat Thomas Sorber DNP row.
Its final box omits Sorber and replaces the first-quarter values.
The test uses synthetic scores and stats; it does not claim to reproduce the actual final box.
Rebuild the identity fixture from the supplied backup on the private stack:

```sh
STATS_BACKUP_PATH=/path/to/data.sql node tests/db/stats-certification-backup.mjs
```

Run `npm run check:quality` on the Mac after generating database types and shared Edge files.
