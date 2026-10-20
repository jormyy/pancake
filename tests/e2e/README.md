# Browser and season checks

## Setup

Use the isolated [local stack recipe](../../docs/verification.md#local-stack).
The runner loads `.env` and accepts the app's public URL, public key, API URL, and local server secret.
`tests/e2e/env.mjs` defines explicit E2E overrides and target checks.
`E2E_ADMIN_SECRET` must match the local Edge API value when a check uses E2E routes.
Never use production for fixture writes.

```sh
npm run e2e:seed
npm run build:web:release
node tests/e2e/static-web-server.mjs --root=dist --port=8082
```

Run the server in a separate terminal and set `E2E_FRONTEND_URL` to its URL.
Seeding creates users and a league. It removes the previous seed's owned resources.
The generated seed state contains local test credentials. Keep it untracked.

## Supported web clients

Pancake supports iPhone Safari, an installed iPhone PWA, and desktop browsers.
The matrix uses WebKit phone layouts at 390x844 and 393x852.
Each phone size runs in tab mode and simulated standalone mode.
Desktop Chromium and WebKit run at 1280x720 and 1440x900.
Standalone flags and safe-area insets are simulated.
Physical installation, the real iOS keyboard, and background suspension need a real iPhone.

```sh
npm run e2e:web-targets
npm run e2e:web-targets -- --actions
npm run e2e:web-targets -- --gameplay
```

The default matrix checks launch, layout, inputs, offline behavior, and update handling.
Actions cover forms, settings, filters, paging, and pending controls.
Gameplay checks real local league, lineup, waiver, draft, and trade settlements.
Some permission, clipboard, ranking-failure, and push responses are explicit browser simulations.
Those simulations do not prove provider delivery or physical device prompts.

| Variable | Purpose |
| --- | --- |
| `E2E_WEB_TARGET_FILTER` | Select client targets |
| `E2E_WEB_ACTION_CASE` | Select action cases |
| `E2E_WEB_ACTION_SCENARIO` | Select gameplay scenarios |
| `E2E_BROWSER_ARTIFACT_DIR` | Move legacy browser output |
| `E2E_PWA_PREVIOUS_ROOT`, `E2E_PWA_NEXT_ROOT` | Supply two stamped builds for update checks |

Without both build roots, the matrix reports the two-build check as not run.
Long action and gameplay matrices need separate invocations and filters for the CI time limit.
The default matrix remains the PR browser check.

## Layout stability sweep

Use the [layout guide](layout-stability-README.md) for isolated keys, ports, recorder controls, and comparisons.
It owns the layout targets, scenarios, metrics, and output limits.

```sh
npm run e2e:layout-stability -- --help
npm run e2e:layout-stability -- --list
```

## Focused browser scenarios

`tests/e2e/browser-scenario-manifest.mjs` lists the registered scenario IDs.
Use the shared scenario runner for one check:

```sh
node tests/e2e/browser-ci-scenario.mjs --scenario=smoke
```

| Command | Behavior |
| --- | --- |
| `npm run e2e:browser-auth` | Sign-in, session persistence, and sign-out |
| `npm run e2e:browser-gameplay` | Auction bid persistence |
| `npm run e2e:browser-lineup` | Manual moves and cross-session agreement |
| `npm run e2e:browser-lineup-auto-set` | Manual Auto-set actions |
| `npm run e2e:browser-lineup-locked` | Locked and invalid move rejection |
| `npm run e2e:browser-waiver` | Claim submission |
| `npm run e2e:browser-trade` | Trade scenarios selected by flags |
| `npm run e2e:browser-playoff` | Bracket progression and champion display |
| `npm run e2e:browser-rookie-draft` | Timed rookie auto-pick |
| `npm run e2e:browser-pwa-launch` | Cached shell, handoff, relaunch, and offline boot |

Use the manifest and each scenario's source for additional flags.
A route-load screenshot does not prove settlement or full-season behavior.
Missing paint entries remain unknown; use `npm run e2e:pwa-paint-probe` for diagnosis.

## Performance budgets

`tests/e2e/performance-budgets.json` owns the workflow thresholds.
These commands measure the seeded app and enforce saved reports:

```sh
npm run e2e:browser-perf
npm run e2e:data-latency
npm run perf:budget -- --require-report --require-data-report
```

Release shards also require workflow reports through `--require-workflow-reports`.
A contract-only budget pass does not prove measured browser or API performance.
Keep fixture setup outside measured segments and report missing metrics explicitly.

## Perpetual-season harness

`npm run e2e:perpetual` uses an isolated local stack and controlled time.
It checks finalization, playoff progression, rollover, new matchups, balances, and the rookie fallback.
The default covers two consecutive rollovers.
`--rollovers=N` changes that count. `--disable-boundary` provides a negative control.
It also checks grace-period immutability and waiver-drain recovery.
This synthetic harness differs from the [historical replay](../../docs/season-simulator.md).

## Soak and release shards

```sh
npm run e2e:soak
npm run e2e:soak:release
```

The exploratory command defaults to ten seasons.
The release command requires twenty seasons and enables mandatory slices.
The harness starts fake providers, but the running Edge functions must point to those endpoints.
Use the environment and migration preparation in `.github/workflows/release-soak-shard.yml`.
The release gate needs a valid pre-upgrade baseline and the approved pending migration range.
A fully migrated stack cannot prove the mid-life migration step.

`tests/e2e/backend-scenario-manifest.mjs` defines backend slices.
`tests/e2e/soak-shards.mjs` assigns coverage across release shards.
Disabled exploratory slices remain skipped and cannot establish full acceptance.
Runtime and memory drift checks apply to runs of ten or more seasons.
Their results measure the harness on one host, not production growth or billing.
Use negative controls before trusting changes to assertion families.

## Generated files

`tests/e2e/surface-matrix.json` owns the route and evidence contract.
Run `npm run check:surface-matrix` after changing routes or evidence identifiers.
Default reports, seed state, screenshots, and snapshots use ignored paths under tests.
Custom output belongs outside the checkout or under the ignored artifact directory.
`npm run parity:players` writes source comparisons there without editing tracked docs.
