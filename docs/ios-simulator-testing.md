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
Startup adds the roster-plan fixture to older seed data without a reset.
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

This command starts or reuses the shared service.
It exports the current worktree against that local service.
One lock covers the source copy, dependency setup, export, and public files.
Other checkouts wait until the export finishes.
The copy includes the `core` workspace.
It isolates Metro's cache and checks the exported connection values.
Each export records its source fingerprint in `ios-build.json`.
The runner checks the served fingerprint against the requesting checkout before it starts the device.
It also checks the installed page fingerprint before sign-in.
Sign-in clears old worker registrations and build caches.
Each exported worker uses its own build version.
Each export also uses separate asset URLs to prevent Safari from mixing old and new scripts.
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
| `--scenario lifecycle` | Refresh, background, return, and show offline state |
| `--scenario player-from-players` | Run one named scenario |
| `--output /private/tmp/my-report` | Choose an external report directory |
| `--scenarios /path/to/scenarios.json` | Use a custom scenario list |
| `--rebuild` | Force a new export |
| `--native` | Check native controls and video analysis without Appium web commands |

The default scenario list lives in `scripts/ios-sim/scenarios.json`.
The baseline has no separate Dynasty tab.
Its Dynasty scenario follows the legacy bookmark into Players rankings.
Settings scenarios cover profile editing, password changes, lineup options, and player filters.

## Add a scenario

Add a JSON row with a unique name, starting route, and measured steps.
Use `prepare` for setup actions that you do not want to measure.
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
Actions include `tap`, `tapPrefix`, `fill`, `select`, `sequence`, `open`, `refresh`, `background`, and `offline`.
`open` measures a full document navigation for bookmarks without an app control.
Other navigation actions use native taps.

The offline action blocks this page's fetch calls and changes its online signal.
It does not change the MacBook's network or another simulator's network.
This tests the app's offline response, rather than an iPhone radio failure.
The refresh action performs a native downward drag.
Its report does not claim that a refresh request occurs unless the recording shows one.

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

The server inserts the recorder into the served HTML before app scripts.
It does not change the saved export or repository files.
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

## Baseline on origin/main

The baseline uses commit `8a33034cdfcec1d32dc5a76ffb130ae7a205dd5f`.
Both full runs pass 28 measured steps.
Their measured activity overlaps for 185 seconds.
The forced native run passes two steps and records 102 video change regions.
The final recorder check passes all nine sign-in and tab steps.

[Primary report](/private/tmp/claude-501/pancake-ios-sim/origin-main-before-a/report.md) lists every recorded event.
[Parallel report](/private/tmp/claude-501/pancake-ios-sim/origin-main-before-b/report.md) contains the second device's measurements.
[Native fallback report](/private/tmp/claude-501/pancake-ios-sim/native-verified/report.md) contains the video check.

The primary run records 2,598 rectangle changes, 31 content changes, 442 appearances, and 122 disappearances.
Sheet animations contribute many of these events.
These counts describe observations, rather than confirmed app defects.

Matchup labels change from `DEN OFF` to a game line after its first meaningful paint.
The player page changes `Roster status` to `Free agent` after its first meaningful paint.
Lineup labels change from `No game` to scheduled opponents after its first meaningful paint.
The full report includes times and rectangles for these changes.

| Screen or action | First content (ms) | Requests | Visible changes |
| --- | ---: | ---: | ---: |
| sign-in | 942 | 35 | 97 |
| matchup | 557 | 30 | 101 |
| roster | 471 | 21 | 37 |
| players | 437 | 28 | 109 |
| trades | 514 | 9 | 0 |
| league | 585 | 5 | 0 |
| draft | 479 | 6 | 0 |
| dynasty | 1081 | 32 | 6 |
| profile | 398 | 5 | 5 |
| player-from-players | 446 | 15 | 3 |
| player-from-roster | 164 | 1 | 647 |
| player-from-roster-page | 448 | 13 | 0 |
| season-change | 496 | 4 | 22 |
| free-agent-add-drop-picker | 165 | 12 | 1733 |
| waiver-claim | 390 | 17 | 102 |
| waiver-claim-choose-drop | 98 | 0 | 0 |
| lineup | 450 | 20 | 161 |
| lineup-move | 165 | 19 | 15 |
| lineup-restore | 666 | 18 | 30 |
| trade-composer | 431 | 3 | 0 |
| profile-edit | 88 | 0 | 125 |
| change-password | 387 | 3 | 0 |
| lineup-options | 348 | 0 | 0 |
| player-filter-settings | 347 | 0 | 0 |
| player-filter-settings-season | 381 | 0 | 0 |
| pull-to-refresh | 1 | 0 | 0 |
| return-to-app | 1 | 0 | 0 |
| offline-banner | 13 | 0 | 0 |

Pull-to-refresh keeps existing content visible and makes zero new requests in this baseline.
Returning to the app also keeps existing content visible.
Those two timings measure retained content, rather than a fresh download.

Artifacts stay outside the repository under the report directories above.
The shared service is stopped after verification.
Run the shared start command before using it again.
