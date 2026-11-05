# Verification handoff

The local static release signs in and passes the requested Home and Start-pin journeys at both widths.
No app code, package manifest, documentation directory, or original Supabase config changes.
No commit, staging, branch switch, hosted access, or deployment occurs.

## Changed files

- `.claude/skills/verify-pancake/SKILL.md` owns launch, doctor, drive, evidence, cleanup, and helper instructions.
- `.claude/skills/verify-pancake/features/README.md` indexes the full feature map.
- Feature files cover `sign-in`, `home`, `roster`, `lineup`, `players-waivers`, `trades`, `league`, `player`, `draft`, `settings`, and `pwa`.
- `tools/verify/launch.sh`, `doctor.sh`, `cleanup.sh`, and `browser.sh` expose the commands.
- `tools/verify/run.mjs` owns isolated setup, build, process ownership, health checks, and cleanup.
- `tools/verify/browser.mjs` owns the isolated browser and real-form login.
- `tools/verify/fixture.mjs` extends the existing seed with required local data.
- `tools/verify/observe.mjs` captures read-only database evidence.
- `tools/verify/run.test.mjs` contains four focused helper tests.
- `tools/verify/README.md` documents invocation and setup limits.
- `tools/verify/HANDOFF.md` records this result.

The repository ignores `.claude/`.
The orchestrator must force-add `.claude/skills/verify-pancake/` when it stages this lane.
The files exist but ordinary `git status` omits them.

## Commands and results

| Command | Result |
| --- | --- |
| `tools/verify/launch.sh` with Node 22 on PATH | Pass after fixing seed flags, taxi fixture setup, and local core compilation |
| `tools/verify/doctor.sh EVIDENCE` | Pass; 775 migrations, correct source revision, local auth, Edge, web, and fixtures |
| `tools/verify/browser.sh EVIDENCE login` | Pass through the exported app’s real sign-in form |
| Home day selection, 390×844 and 375×844 | Pass; date highlight and lineup content change together |
| Home and Roster → Auto-set → Edit lineup manually | Pass |
| Start pin, 390×844 and 375×844 | Pass; bench player becomes a starter and persists after navigation |
| Auto and Bench controls | Pass; Auto removes the pin, Bench removes the starting assignment |
| `node --test tools/verify/run.test.mjs` | Four passed, zero failed |
| `npx eslint tools/verify/*.mjs` | Pass |
| `sh -n tools/verify/*.sh` | Pass |
| `tools/verify/cleanup.sh EVIDENCE` | Pass; own containers, processes, and browser removed |
| Evidence check after cleanup | Pass; 11 fresh screenshots and database observations survive; the earlier run retains 12 screenshots |

`testselect.py` reports unmapped helper files and suggests Vitest for the test filename.
That test uses Node’s runner, so the explicit command above is its covering test.
No full suite runs.

## Evidence

The latest successful directory is `/Users/michaelchen/Documents/pancake-verify-evidence/pancake-verify-mw2jn3lu-97f6913c/`.
The earlier completed run remains at `/Users/michaelchen/Documents/pancake-verify-evidence/pancake-verify-mw2iscxd-605f615f/`.
Read `proof.json`, `helper-tests.txt`, and `doctor.txt` first.
Screenshots use `home-*`, `lineup-*`, and `roster-autoset-*` names.
Database files show no initial starter assignment, a persisted Start pin and starter, a Bench pin without a starter, and Auto without a pin.
The same player moves from G to PG after later optimization; either is a legal starting slot.
Both completed runs and all four failed setup attempts have been cleaned up. Do not restart their stacks.

The directory also contains private local keys, seed passwords, and runtime logs.
Share only the proof, screenshots, snapshots, and filtered database observations.

## Setup on this Mac

- Node 22.23.2 is explicitly placed before the default Node 26.7.0 on PATH.
- Its installation path is `/Users/michaelchen/.nvm/versions/node/v22.23.2/bin`.
- `npm ci --ignore-scripts --no-audit --no-fund` installs only existing lockfile dependencies.
- The helper compiles core in the disposable copy and links that copy’s workspace package there.
- Docker 29.6.2 is already running; this run does not start the desktop app.
- Supabase CLI 2.114.0 supplies the local stack and generated local credentials.
- PostgreSQL client 14.21 suffices for these helpers, which do not use `psql`’s newer `\getenv` command.
- The installed agent-browser 0.25.4 uses a fresh headless Chromium session.
- Chromium runs at iPhone dimensions. No actual iPhone or Safari session is driven.

## Remaining work

`components/LineupPinControl.tsx` renders pin radios without `aria-checked` in the exported web app.
The selected segment looks correct and its database state persists, but the accessibility snapshot reports every option unchecked.
This is reproduced and recorded in the feature map. That component is outside this lane’s allowed paths.

The remaining feature journeys have recipes but have not run in this lane.
Physical iPhone standalone behavior, push delivery, and two-build PWA update checks remain unverified.
The seed has no completed past season. League History needs that fixture before its journey can pass.
Historical player statistics, news, and populated playoff checks also need their stated fixtures.
