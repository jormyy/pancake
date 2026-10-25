# Test the installed iPhone web app

This runner tests Safari web apps on iPhone 17 Pro simulators with iOS 26.5.
It uses real Home Screen installation and native taps.
It keeps exports, local keys, videos, screenshots, and reports outside the checkout.
It does not change app code or the checkout's Supabase configuration.

## Setup

1. Start Docker on this MacBook.
2. Install Xcode 26.6 and the iOS 26.5 Simulator runtime.
3. Install Appium and its XCUITest driver.
4. Install the Supabase CLI, Node, npm, ffmpeg, and ffprobe.
5. Run commands from the worktree you want to test.

The runner uses `/opt/homebrew/bin/ffmpeg` for video analysis.
Appium and XCUITest are already installed on the owner's MacBook.
The app needs no new runtime dependencies.
The runner installs existing npm dependencies in its external source copy.
It does not load the checkout's `.env` files.

## Start the shared data service

```sh
node scripts/ios-sim/stack.mjs start
```

The shared service uses project `pancake_ios_shared` and these fixed ports:

| Service | Address or port |
| --- | --- |
| Supabase API | `http://127.0.0.1:57121` |
| Edge API | `http://127.0.0.1:57121/functions/v1/api` |
| Database | `57122` |
| Shadow database | `57120` |
| Reserved Studio | `57123` |
| Reserved mail | `57124` |
| Reserved analytics | `57127` |
| Reserved pooler | `57129` |
| Edge inspector | `57183` |

Startup uses a process lock.
Concurrent callers wait for the first caller.
If a runner crashes, a stale lock produces an error.
Remove that named lock only after confirming its owner has stopped.
Startup reuses completed seed data.
Every start refreshes copied Edge functions and migration files, including removal of stale files.
Startup restarts its Edge worker so code edits take effect without a database reset.
Startup adds the roster-plan fixture to older seed data from the same Eastern date.
Startup and captures reject old dates with `run start --reset`.
Only the shared service owner resets data after other captures stop.
It never resets that data without `--reset`.
It refuses a different migration set on an existing shared service.
Database cron jobs stay disabled.
This prevents live provider imports from changing the fixtures.

The fixture uses the existing E2E league seeder.
It adds full rosters, taxi acquisitions, injuries, games, game lines, projections, rankings, waivers, trades, and transaction history.
It includes ten managers and draft rooms in season 2027.
Each team has twenty active players, one IR player, and one taxi player.
Each team has an open IR slot.
The player pool includes healthy free agents, Out free agents, and players on waivers.
Games include final, live, and upcoming states.
Player histories cover two seasons.

On this MacBook, connection files live here:

```text
/private/tmp/claude-501/pancake-ios-sim/stack/seeded-logins.json
/private/tmp/claude-501/pancake-ios-sim/stack/local-stack.json
```

The first file contains the local public key, league ID, password, and manager logins.
The second also contains the local service key.
These files contain local test values only.
Other user IDs use their own `/private/tmp/claude-<uid>/pancake-ios-sim` directory.

| Manager option | Login |
| --- | --- |
| `--manager 0` | `pancake-e2e-iossim2027-1@example.com` |
| `--manager 1` | `pancake-e2e-iossim2027-2@example.com` |
| `--manager 2` | `pancake-e2e-iossim2027-3@example.com` |
| `--manager 3` | `pancake-e2e-iossim2027-4@example.com` |
| `--manager 4` | `pancake-e2e-iossim2027-5@example.com` |
| `--manager 5` | `pancake-e2e-iossim2027-6@example.com` |
| `--manager 6` | `pancake-e2e-iossim2027-7@example.com` |
| `--manager 7` | `pancake-e2e-iossim2027-8@example.com` |
| `--manager 8` | `pancake-e2e-iossim2027-9@example.com` |
| `--manager 9` | `pancake-e2e-iossim2027-10@example.com` |

All seeded managers use password `Pancake-e2e-iossim2027!`.
Manager 0 is the commissioner.
Manager 1 also receives a pending overflow trade with a taxi rookie; IR and taxi trades are enabled for its roster-plan editor.

Only the shared service owner stops or resets it.
Stop all users of the service before resetting it.

```sh
node scripts/ios-sim/stack.mjs stop
node scripts/ios-sim/stack.mjs start --reset
```

`stop` preserves data for the next start.
`start --reset` deletes this service's old data and seeds it again.

## Run a scenario

```sh
node scripts/ios-sim/run.mjs \
  --device 'Pancake lane player' \
  --port 58201 \
  --manager 2 \
  --scenario all
```

This command connects to the shared service.
It exports the current worktree against that local service.
One lock covers the source copy, dependency setup, export, and public files.
Other checkouts wait until the export finishes.
The copy includes the `core` workspace.
It isolates Metro's cache and checks the exported connection values.
Each export records its source fingerprint in `ios-build.json`.
The runner checks the served fingerprint against the requesting checkout before it starts the device.
It also checks the installed page fingerprint before sign-in.
Sign-in clears old worker registrations and build caches.
Release stamping gives each worker a version and a verified boot manifest.
Content hashes keep asset URLs tied to their exported bytes.
The runner requires a controlling worker before background and offline steps.
A forced rebuild uses a new directory to protect exports that other runs serve.
It serves the export on the requested loopback port.
It creates the named simulator when needed.
It refuses devices that this harness does not own.
It uses fresh iPhone 17 Pro devices with the iOS 26.5 runtime.

On first use, Appium opens Safari and follows Share, Add to Home Screen, and Add.
It names the icon `Pancake <web-port>`.
It launches the app through that Springboard icon.
Later runs can reuse that icon.
The runner checks standalone display mode before recording a passing result.
It signs in through the app's form.
It dismisses the simulator's password-save prompt.

The runner records video before installation.
It saves a screenshot and accessibility tree after each measured step.
It shuts down the device and stops its own web server, video recorder, and Appium session afterward.
It preserves its created devices for reuse.
It leaves the shared data service running for other lanes.

Use a different manager, device name, and web port for each parallel run.
Managers have locks because lineup scenarios change their lineup.
Device names and all control ports also have locks.
Adjacent web ports use separate Appium and video ports.
Use `--appium-port` when you need a specific control port block.
That option reserves the given port and the next two ports.

Run two lanes in separate terminals:

```sh
node scripts/ios-sim/run.mjs --device 'Pancake lane A' --port 58202 --manager 3 --scenario all
```

```sh
node scripts/ios-sim/run.mjs --device 'Pancake lane B' --port 58203 --manager 4 --scenario all
```

Useful options:

| Option | Meaning |
| --- | --- |
| `--scenario all` | Run every supplied scenario |
| `--scenario tabs` | Open each main screen |
| `--scenario interactions` | Open player pages, pickers, forms, and lineup controls |
| `--scenario lifecycle` | Background, return, and show offline state |
| `--scenario player-from-players` | Run one named scenario |
| `--output /private/tmp/my-report` | Choose an external report directory |
| `--scenarios /path/to/scenarios.json` | Use a custom scenario list |
| `--rebuild` | Force a new export |
| `--stack-dir /path/to/local-stack` | Seed and use a separate local Supabase stack |
| `--native` | Check native controls and video analysis without Appium web commands |

The default scenario list lives in `scripts/ios-sim/scenarios.json`.
It contains 21 scenarios and 26 measured steps, plus sign-in.
The lifecycle group contains two measured steps.
Each capture clears the installed app's cached pages before sign-in.
The runner refreshes stale HTML before it waits for its recorder connection.
Surface files live in `scripts/ios-sim/scenarios/`.
These files replace the removed subsets:

| Removed files | Replacement |
| --- | --- |
| `home-final.json`, `home-manual.json`, `home-timing.json`, `home-optimizer-state.json`, `home-week-off.json` | `home.json` |
| `player-claim-ir.json` | `player-ir-actions.json` |
| `player-resolution.json` | `player-controls.json` |
| `player-lists.json` | `players.json` |

Shared trade scenarios live in `trades.json`.
`trade-review.json` and `trade-wave2.json` keep their unique cases.
Use manager 1 for `trade-wave2.json`; its incoming offer belongs to that manager.
Use manager 3 for `home.json`; its first score breakdown has no game stats.
Use manager 0 for home moves and roster dialog captures.
Use manager 6 for `roster.json` to view another team in the standings.
Use manager 2 for `league-cached-bid.json`; the bidder must differ from the auction leader.
Roster dialogs create and restore their roster limit, Sunday lineup, and live auction nomination.
Waiver captures create separate claim and active award fixtures, then restore the roster.
Acquisition captures also restore their add counts and transaction rows.
Steps with `allowClock` record clock digit changes without delaying settlement.
Clock movement, disappearance, and other text changes still delay settlement.
The default list has no separate Dynasty tab.
Its Dynasty scenario follows the legacy bookmark into Players rankings.
Settings scenarios cover profile editing, password changes, lineup options, and player filters.

## Add a scenario

Add a JSON row with a unique name, starting route, and measured steps.
Use `prepare` for setup actions that you do not want to measure.
Use `reveal` to scroll a labeled control into view without activating it.
A reveal starts its measurement clock without a tap.
Use `repeat` with a positive integer to repeat a scenario, including preparation.
Repeated report names end in `-repeat-1`, `-repeat-2`, and so on.
Keep each scenario name unique across the surface files.
Use a specific real-content marker in `expected`.
Do not use a spinner, page title, or persistent navigation button as the marker.

```json
{
  "name": "player-details",
  "group": "interactions",
  "from": "/players",
  "prepare": [
    { "fill": "Search players", "value": "{{freeAgent.display_name}}" }
  ],
  "steps": [
    {
      "action": { "tap": "Open {{freeAgent.display_name}}" },
      "expected": {
        "route": "/player/{{freeAgent.id}}",
        "selector": "select[aria-label='Season']"
      }
    }
  ]
}
```

Fixture names include `rosterPlayer`, `benchPlayer`, `freeAgent`, `waiverPlayer`, `outPlayer`, `lineupSlot`, `teamName`, `displayName`, and `otherTeam`.
Actions include `tap`, `tapPrefix`, `fill`, `select`, `sequence`, `open`, `background`, and `offline`.
`open` measures a full document navigation for bookmarks without an app control.
Other navigation actions use native taps.

The offline action blocks this page's fetch calls and changes its online signal.
It does not change the MacBook's network or another simulator's network.
This tests the app's offline response, rather than an iPhone radio failure.

## Read the report

Each run writes these files:

| File | Contents |
| --- | --- |
| `report.md` | Screen timings, request counts, results, and every recorded change |
| `report.json` | Full measurements, event details, clock values, and sampling cost |
| `video.mp4` | Simulator recording |
| `<step>.png` | Screenshot after the step |
| `<step>.xml` | Native accessibility tree after the step |
| `appium.log` | Simulator automation log |
| `video-differences.json` | Changed pixel regions when web inspection is unavailable |

The first expected real content defines the first meaningful paint.
The tap clock starts on the page's first pointer, mouse, or touch event.
Bookmark, lifecycle, and forced native actions use the command clock instead.
Those timings include automation delay and provide an upper bound.
The recorder samples visible element rectangles on animation frames.
A MutationObserver also watches DOM and attribute changes.
Sampling pauses while the app is hidden.

After the first meaningful paint, the report records:

- Elements that appear or disappear.
- Text, accessibility-label, or role changes.
- Position or size changes of at least half a CSS pixel.
- Each event's time, element identity, and before and after rectangles.

An observation lasts at least 3.5 seconds.
It ends after 1.2 seconds without visible changes or new requests.
It fails to settle after 12 seconds.
Missing real content fails the step.
Missing measurements also fail the step with a reason.
The runner waits for the recorder before each action.
At the deadline, it requests one final observation.
The recorder retries a failed report upload during that request.
Sampling errors include their reason and any collected measurements.
A sign-in that shows authenticated league content continues even when the screen does not settle.
Every unsettled step keeps its measurements and fails.
The runner continues through the remaining steps.
Missing sign-in content, missing recordings, and Safari tab mode still fail.
Visible changes remain findings even when the scenario completes.
Intentional animations appear in the findings too.

Request counts include page-initiated fetch, XHR, and resource loads.
They exclude the recorder's control and report traffic.
They can include cache hits.
They do not count WebSocket messages as HTTP requests.
The report stores each request's path and start time without query values.

The exporter inserts the recorder before app scripts, then stamps the release.
The server serves those exact bytes, so worker hash checks cover the measured pages.
This also allows measurements when Appium cannot inspect the web view.
That fallback adds ffmpeg frame differences from the recorded video.
Pixel differences cannot identify element roles or explain why pixels change.
Their element labels and previous rectangles therefore remain unknown.

The [Appium capabilities reference](https://appium.github.io/appium-xcuitest-driver/latest/reference/capabilities/) describes webview discovery options.

## Check the harness

The focused tests live in `tests/ios-sim/`.
They check real-content detection, visible changes, missing observations, hidden-page suspension, locks, port separation, cleanup, local targets, and command failures.
Run checks while the source lock protects the external copy:

```sh
node --input-type=module -e 'import {sourceSnapshot} from "./scripts/ios-sim/build.mjs"; import {run} from "./scripts/ios-sim/common.mjs"; await sourceSnapshot(async ({snapshot}) => { console.log(await run("npm", ["run", "check:quality"], {cwd: snapshot})); console.log(await run("node", ["node_modules/vitest/vitest.mjs", "run", "tests/ios-sim", "tests/e2e-release-contracts.test.ts"], {cwd: snapshot})); })'
```

The source copy contains the current tracked files and unignored additions.
The quality checks do not need a production connection.
