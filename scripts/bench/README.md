# Local benchmarks

Use isolated local databases. Keep raw inputs and reports outside the repository.
These harnesses modify fixtures, cron entries, and local clocks.
They do not measure hosted Edge startup, CPU quotas, internet latency, or billing.

## Pre-tipoff season benchmark

Use a separate Supabase project on ports 563xx.
The driver rejects other database hosts and ports.
Prepare a baseline source copy and a candidate copy with installed dependencies.
Set `SUPABASE_DB_URL` to the isolated database.
Set `BASE_SOURCE` to the baseline copy and `EVIDENCE` to an external output directory.
Disable automatic cron execution on that stack before measuring.

Save the transport function before installing the benchmark shim:

```sh
psql "$SUPABASE_DB_URL" -X -At -c "SELECT pg_get_functiondef('net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure)" > "$EVIDENCE/net-restore.sql"
deno run --no-lock --node-modules-dir=none -A scripts/bench/prepare-schedule.ts "$EVIDENCE"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/base-schema.sql
deno run --no-lock --node-modules-dir=none -A scripts/bench/pre-tipoff.ts old "$BASE_SOURCE" "$EVIDENCE" old
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/restore-clock.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261014000001_pre_tipoff_lineups.sql
deno run --no-lock --node-modules-dir=none -A scripts/bench/pre-tipoff.ts new "$PWD" "$EVIDENCE" new
```

The baseline must precede the pre-tipoff scheduler migration.
A fifth driver argument limits the number of simulated days for diagnosis.
A short run cannot establish full-season savings.
The fixed seed, projections, injuries, and schedule stay equal across versions.
The independent oracle checks eligibility, locks, and maximum projected points at each tipoff.
SQL counters include nested statements. They do not measure disk bytes or CPU time.

```sh
deno run --no-lock --node-modules-dir=none -A scripts/bench/compare.ts "$EVIDENCE" old new
deno run --no-lock --node-modules-dir=none --allow-read --allow-write scripts/bench/report-metrics.ts "$EVIDENCE" old new
deno run --no-lock --node-modules-dir=none --allow-read --allow-write scripts/bench/verify-tipoffs.ts "$EVIDENCE" new
deno test --no-lock --node-modules-dir=none scripts/bench/oracle.test.ts
deno run --no-lock --node-modules-dir=none -A scripts/bench/dispatch-concurrency.ts
deno run --no-lock --node-modules-dir=none -A scripts/bench/lineup-concurrency.ts
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/bench/restore-clock.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$EVIDENCE/net-restore.sql"
```

Restore cron entries from their migrations before reusing this database for integration tests.

## Screen and job capacity profile

Use project ID `pt0493perf`, API port 56321, and database port 56322.
Shift every Supabase port to the assigned block in the isolated copy's configuration.
The environment helper rejects other targets.
It reads only that stack's local status and creates private environment files.

```sh
supabase start -x studio,imgproxy,vector,logflare,supavisor
node scripts/bench/profile-env.mjs --setup
supabase functions serve --no-verify-jwt --env-file .env.perf-functions
```

Restart that stack's PostgREST container after setup so pooled sessions inherit statement tracking.
Use another shell for the profile:

```sh
. ./.env.perf-run
npm run bench:profile -- --label baseline --rounds 5 --out ../evidence --jobs all
npm run bench:profile:report -- ../evidence/baseline.json ../evidence/baseline.md
```

Use a new label; the runner refuses existing reports.
`--jobs none`, `--jobs sql`, and `--jobs all` select job coverage.
`--phase reads` or `--phase jobs` selects one phase.
`--only NAME,NAME` selects named cases.
By default, the runner recreates its fixture and disables cron entries.

The fixture source in `scripts/bench/profile-seed.sql` defines the dataset and exact counts.
It varies scoring settings and includes rosters, lineups, history, picks, and drafts.
This dense synthetic workload does not represent average production traffic.
Reads use authenticated HTTP. Response sizes count decoded bodies.
Jobs run production handlers through local PostgREST with pinned provider responses.
Inspect returned outcomes: idle work and failed imports do not prove successful ingestion capacity.

The runner restores the database clock in its cleanup path.
After forced interruption, restore it explicitly:

```sh
node scripts/bench/profile-env.mjs --restore-clock ../evidence
```

Stop only the recorded function process and the owned `pt0493perf` stack.
Leave other projects and the shared Docker VM running.

## Interleaved scoring comparison

Keep baseline and candidate source copies on the same isolated stack.
Use identical benchmark scripts, runtime, dataset, provider cache, and arguments.
Generate each copy's local environment with the helper.
Let the unchanged scorer complete cold historical repair before warm comparison.
Confirm the warm fixture matches the seed and has all expected scoring certificates.

Run cold preparation in the baseline copy:

```sh
npm run bench:profile -- --label warmup-before --rounds 1 --single-sample true --prime false \
  --phase jobs --jobs all --only sync-scores-engine-no-provider --out ../evidence
```

Exclude that cold sample from warm results.
Then run from the candidate copy:

```sh
npm run bench:profile:compare -- --label scoring-after --rounds 5 --out ../evidence --before ../before --after .
npm run bench:profile -- --label reads-after --rounds 5 --out ../evidence --phase reads --jobs none --reuse-fixture true
```

The comparison alternates baseline and candidate observations on the same warmed fixture.
It checks equal scores, standings, score timestamps, and notification content.
It records source hashes, output digests, statement snapshots, plans, and host load.
Run no competing workload during measurement.
See [measurement limits](../../docs/supabase-performance-capacity.md).

## Regression checks

```sh
npm run test:bench:profile
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:56322/postgres npm run test:db:skipped-week-certificates
deno test --no-lock --node-modules-dir=none -A scripts/bench/profile-span-certificates.ts -- --before ../before --out ../evidence/span-certificates.json
```

The database command requires the isolated migrated stack.
The span profile reuses that stack and writes external evidence.
Its baseline must contain the unchanged scorer pinned in `scripts/bench/profile-span-certificates.ts`.
Use `scripts/bench/profile-psql.mjs` as the guarded local psql wrapper when the host lacks psql.
It permits only the assigned database container and port.
