# Game-night replay lab

This lab runs real migrations, cron, the dispatcher, and Edge workers against a scripted NBA feed.
It creates its own local Supabase project, ports, and synthetic database, then stops that stack.
It rejects non-loopback database and API hosts.
It never needs production data or credentials.

## Run

Use the repository's Node, Docker, and Supabase CLI prerequisites.
Evidence must stay outside the repository; the default is a temporary `pancake-game-night` directory.

```sh
node scripts/bench/game-night/run.mjs --help
node scripts/bench/game-night/run.mjs --public-live --quality --policy --pool 2 --shared-buffers 32MB --evidence ../game-night-evidence
```

The fixture contains ten teams, about 2,600 players, 246,000 historical stat rows, and about 265 MB of database allocation.
Training uses seven staggered games; held-out uses twelve with heavier overlap.
A normal sample has a four-minute real-time window and bounded final settlement.
Source cadence is not accelerated.
The fixed database cap is 192 MiB with swap available.

## Compare and verify

`architecture-series.mjs` interleaves baseline and public-mode candidate in ABBAAB order.
Pass `--baseline` for a separate reference checkout, `--candidate`, and `--evidence`.
`settings-series.mjs` compares settings alone.
`series.mjs --help` grades existing reports without starting a stack.
`held-out-series.mjs` and `run.mjs --phase held-out` require passing training evidence.
Never use held-out data for tuning.

Reports include the cgroup anonymous refault rate, memory, diagnostic VM swap, WAL, function time, sessions, workers, connections, work counts, and quality gates.
The resource grader records VM available memory and foreign containers; it rejects samples below the fixed 1 GiB floor.
Foreign containers stay untouched.
The kernel does not expose normal per-cgroup swap-out traffic; reports state that limit.

`--phase controls` proves broken finals and disabled ingestion fail.
With quality and phone options, it also exercises failing action, broadcast, freshness, and phone-final gates.
`verify-phone-history.mjs` covers past days, official correction, and delayed-final handoff.
`verify-settings.mjs` runs selected SQL schedule checks on its own stack.
Action comparisons require frozen paired-reference limits through `--limits`.
The source, fixture, harness, settings, and grader hashes identify each report.

## Cleanup and tests

Interrupted runs can be cleaned using their own metadata:

```sh
node scripts/bench/game-night/cleanup.mjs --evidence ../game-night-evidence --project <project-id>
node --test scripts/bench/game-night/*.test.mjs
```

Cleanup accepts only matching owned project metadata.
The unit tests above need no Docker; measurement and SQL commands do.
See [live scores](../../../docs/live-scores.md) for the production contract, separate rollback paths, hosted settings, and labeled lab results.
