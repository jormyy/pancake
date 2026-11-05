# Pancake verification helpers

These helpers build and drive a disposable local Pancake PWA.
The full journey instructions live in [verify-pancake](../../.claude/skills/verify-pancake/SKILL.md).

## Commands

Use Node 22, Docker, the Supabase CLI, a PostgreSQL client, and the installed `agent-browser` CLI.
Install the repository’s existing dependencies before launch.

```sh
npm ci --ignore-scripts --no-audit --no-fund
tools/verify/launch.sh
```

Launch prints `READY`, its URL, the generated test-credential source, and its evidence directory.
Set `EVIDENCE` to that exact directory.
An optional launch argument chooses a new directory outside the repository.

```sh
EVIDENCE='/absolute/path/from/launch'
tools/verify/doctor.sh "$EVIDENCE"
tools/verify/browser.sh "$EVIDENCE" login
tools/verify/browser.sh "$EVIDENCE" snapshot -i
tools/verify/browser.sh "$EVIDENCE" screenshot "$EVIDENCE/home-390.png"
node tools/verify/observe.mjs "$EVIDENCE" > "$EVIDENCE/database-before.json"
tools/verify/browser.sh "$EVIDENCE" set viewport 375 812
tools/verify/cleanup.sh "$EVIDENCE"
test -s "$EVIDENCE/home-390.png"
```

Use the browser wrapper for every browser action.
It supplies an isolated session and ignores personal browser profiles and saved authentication.
`login` types the generated credentials into the real form at 390×844.
It reports submission; require Home’s seeded team before declaring sign-in successful.
Pass a zero-based seed index after `login` to use another generated manager.
Other arguments pass directly to `agent-browser`.
Use `node tools/verify/capture.mjs EVIDENCE FEATURE LABEL` to save a snapshot, screenshot, layout, and database observation together.

## Isolation and evidence

Launch creates `~/Documents/pancake-verify-evidence/<run-id>/` by default.
It copies tracked sources into `work/`, excluding private environment files and key files.
It copies the current helper sources so uncommitted helper edits are included.
It links installed dependencies without copying personal configuration.
It compiles the core package inside the disposable copy and points that copy’s workspace package at the compiled result.
All compilation, generated seed files, database configuration, and logs stay in that directory.

The copied Supabase config receives a unique project ID and an unused port block.
The original config stays unchanged, including on failure.
Launch disables cron jobs in its own database before creating fixtures.
This prevents scheduled ingestion from calling external providers.
It starts the project’s Edge functions with generated local values.
It runs `npm run e2e:seed`, adds verification fixtures, and runs `npm run build:web:release`.
It then adds local news and statistics fixtures and stamps the complete export again. Doctor checks the export manifest.
The project’s static server serves that build on loopback.

`run.json` records source revision, ports, process identities, and cleanup completion.
`fixture.json` records safe fixture IDs, dates, and expected coverage.
`local-env.json`, `functions.env`, `stack.log`, and `work/tests/e2e-state.json` contain local secrets.
The parent directory is private. Do not share those files.
Share screenshots, snapshots, and filtered database observations instead.

Cleanup checks process start times before terminating recorded process groups.
It stops only the unique copied Supabase project and removes its database volume with `--no-backup`.
It closes only the recorded browser session.
It preserves the evidence directory, including setup failures and screenshot files.
Rerunning cleanup is supported; doctor rejects an already cleaned run.

## Fixture coverage

| Fixture | Setup |
| --- | --- |
| Managers | Existing seed creates ten confirmed local accounts |
| Current matchup | Current Eastern-time week, two populated teams |
| Roster | Fourteen active players, one IR player, and one taxi player per team |
| Lineup | Five initial starters; Player008 begins on the first manager’s bench |
| Taxi | Synthetic draft acquisition uses the database’s taxi authorization and eligibility checks |
| Waivers | One pending bid and unrostered players for new claims |
| Trades | One pending two-team offer |
| Drafts | Seeded auction and rookie draft; startup auction completes for season play |
| Past season | Completed season with two regular-season games, a final, standings, and expected history results |

Direct fixture writes only prepare test state.
Journey proof must use visible controls and read-only stored-state checks.

## Local setup limits

The verification run uses desktop Chromium with iPhone viewport dimensions.
It does not prove Safari, physical home-screen launch, keyboard safe areas, or push delivery.
The default run includes one release; update tests require a second verified local build at the same origin.
The extended seed supplies two statistics seasons, local news, and a third roster. Current-season playoffs need an additional fixture.

Node 22 must precede the Mac’s default Node on PATH.
On the implementation Mac, it is installed at `/Users/michaelchen/.nvm/versions/node/v22.23.2/bin`.
That path is a machine-specific prerequisite, not a portable helper assumption.
Docker Desktop is already running on that Mac; the helper does not start or reconfigure it.
The installed Supabase CLI provides local Docker images and status credentials.
The browser command uses the Mac’s installed agent-browser and browser binary.
The implementation run uses PostgreSQL client 14.21, Supabase CLI 2.114.0, and agent-browser 0.25.4.
These helpers do not need the newer psql commands used by the repository’s separate database test recipes.
The initial install uses `--ignore-scripts`; the helper builds the required core output explicitly.
No hosted credentials or production services are required.

## Focused checks

The repository’s selector currently reports these new helper files as unmapped.
Run only their covering checks during iteration.

```sh
node --test tools/verify/run.test.mjs
npx eslint tools/verify/*.mjs
sh -n tools/verify/launch.sh tools/verify/doctor.sh tools/verify/cleanup.sh tools/verify/browser.sh
```

The guard test includes hosted and lookalike endpoints that must fail.
The config test checks copied project identity and private ports.
The feature-map test checks the required areas and generator section shape.
The cleanup test covers late browser creation, repeated cleanup, surviving evidence, and a rejected doctor call after cleanup.
The selector suggests Vitest for the new `.test.mjs` filename, but this file uses Node’s test runner.
Use the explicit `node --test` command above.
Runtime acceptance requires launch, doctor, real login, Home day selection, Start-pin persistence, both viewport widths, and cleanup with surviving evidence.
