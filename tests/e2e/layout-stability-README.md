# Layout stability sweep

This harness measures the release app in headless Chromium and WebKit.
Run it with `npm run e2e:layout-stability -- FLAGS`.
The [browser README](./README.md#layout-stability-sweep) lists targets, scenarios, metrics, and the corrected BEFORE counts.
The final release sweep records 1,870 passes, zero failures, and 50 explained navigation omissions.
All 300 empty-notice returns pass. Chromium CLS is zero; WebKit CLS is unsupported.
The largest sampled displacement is 1.6 CSS pixels, below the unchanged two-pixel threshold.
No blank frames, loading/spinner cells, or reappearances are recorded.
Small steps at or below 0.5 pixels can accumulate without saved movement details and can understate settling time.
Source: release evidence `sweep/round5-handoff.md`, `sweep/final/compare.md`, and `sweep/final/metric-support.md` for release `aff7aac1`.
It never writes to production.
Its API and frontend guards require HTTP loopback on their exact configured ports.
Its database guard requires PostgreSQL loopback on its exact configured port.
The default ports remain 56121, 56122, and 56190.

## Use another assigned port block

Set all three ports when generating the environment for another isolated stack.
The stack configuration and static server must already use those assigned ports.

```sh
node tests/e2e/layout-stability-local.mjs --output-dir=../local --seed=true \
  --api-port=56621 --db-port=56622 --frontend-port=56690
node tests/e2e/static-web-server.mjs --root=dist --port=56690
```

Run the sweep with that environment and its seed state.
The explicit flags below also document the intended port assignment.

```sh
node tests/e2e/layout-stability.mjs \
  --stack-env=../local/local-stack.env --state=../local/tests/e2e-state.json \
  --api-port=56621 --db-port=56622 --frontend-port=56690 \
  --frontend-url=http://127.0.0.1:56690 \
  --label=after --output-dir=../evidence/layout-stability
```

For the 565xx stack, use `--api-port=56521 --db-port=56522 --frontend-port=56590` and frontend URL `http://127.0.0.1:56590`.
Both commands accept `--stack-env=PATH` to read an existing generated environment.
CLI port flags override `LAYOUT_STABILITY_API_PORT`, `LAYOUT_STABILITY_DB_PORT`, and `LAYOUT_STABILITY_FRONTEND_PORT`.
Without those values, the resolver reads ports from `E2E_SUPABASE_URL`, `SUPABASE_DB_URL`, and `E2E_FRONTEND_URL`.
The frontend URL flag can also supply its port when no explicit frontend port exists.
An explicit port that disagrees with an endpoint fails validation before seeding.
Without a port assignment or endpoint, the resolver uses the 561xx defaults.
The generated environment stores the ports, so later sweeps can omit the port flags.
Non-loopback hosts, wrong protocols, mismatched ports, and the production reference remain forbidden.

The browser self-test needs no running stack or static server.
Its port probe intercepts the accepted request and rejects the invalid requests before network access.

```sh
node tests/e2e/layout-stability.mjs --self-test \
  --api-port=56621 --db-port=56622 --frontend-port=56690 \
  --targets=desktop-chromium-1440,desktop-webkit-1440 \
  --output-dir=../evidence/layout-stability/self-test
npx vitest run tests/e2e/layout-stability-ports.test.ts
```

## Run locations

Run browsers, builds, and Supabase only on the mini.
Source the task environment before each remote command.
Keep evidence and generated local keys outside the checkout.
Do not copy a project or profile `.env` file.

```sh
/Users/michaelchen/.cache/supervise/tasks/t_04935f0d/ssh-task mini '<command>'
```

Before each heavy job, run this capacity check locally.
If it exits 3, wait 60 seconds and retry.

```sh
FLEETCAPACITY_SSH_BIN=/Users/michaelchen/.cache/supervise/tasks/t_04935f0d/ssh-task \
  python3 ~/.claude/skills/supervise/scripts/fleetcapacity.py --need-mini --json
```

## Prepare the base copy

Run these commands on the mini.
The shared base stays unchanged.

```sh
. ~/pancake-t_04935f0d/env.sh
mkdir -p ~/pancake-t_04935f0d/lanes/sweep/repo
rsync -a --exclude=.git --exclude=node_modules --exclude=dist --exclude=.expo \
  --exclude='.env*' ~/pancake-t_04935f0d/base/ ~/pancake-t_04935f0d/lanes/sweep/repo/
cd ~/pancake-t_04935f0d/lanes/sweep/repo
npm ci --no-audit --no-fund
python3 - <<'PY'
from pathlib import Path
import re
p = Path('supabase/config.toml')
s = re.sub(r'^project_id = .*', 'project_id = "pt0493sweep"', p.read_text(), flags=re.M)
p.write_text(s.replace('543', '561'))
PY
```

Copy `layout-stability*.mjs` and `web-targets-geometry.mjs` into the mini copy after copying the base.
Do not rebuild app source from another lane for BEFORE measurements.

The task's Supabase shim can lack its companion binary.
Use the task-local companion installed during this run.

```sh
export SUPABASE_GO_BINARY=$HOME/pancake-t_04935f0d/lanes/sweep/tools/supabase-go
```

If that companion is absent, extract the complete approved CLI release inside this lane.

```sh
mkdir -p ../tools
curl -fsSL https://github.com/supabase/cli/releases/download/v2.109.1/supabase_2.109.1_darwin_arm64.tar.gz \
  -o ../tools/supabase.tar.gz
tar -xzf ../tools/supabase.tar.gz -C ../tools
```

## Stack, keys, seed, build, and server

```sh
supabase start -x studio,imgproxy,vector,logflare,supavisor
node tests/e2e/layout-stability-local.mjs --output-dir=../local --seed=true
mkdir -p ../evidence/before
nohup ../tools/supabase-go functions serve --env-file ../local/functions.env \
  > ../evidence/before/functions.log 2>&1 < /dev/null &
echo $! > ../local/functions.pid
set -a
. ../local/local-stack.env
set +a
PANCAKE_RELEASE_SHA=725fa91363c7c0fb858c2647892136dd847f6146 \
  EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 npm run build:web:release
nohup node tests/e2e/static-web-server.mjs --root=dist --port=56190 \
  > ../evidence/before/server.log 2>&1 < /dev/null &
echo $! > ../local/server.pid
npx playwright install chromium webkit
```

`layout-stability-local.mjs` reads only `supabase status -o env` for local keys.
It stores keys with mode 0600.
It runs the existing seed from an external directory, so generated seed artifacts stay outside the checkout.
The sweep adds two populated rosters, starters, news, a pending trade, drafts, and playoff content.
It creates and removes a separate league for the empty-matchup case.

## Verify the recorder

```sh
node tests/e2e/layout-stability.mjs --self-test \
  --targets=desktop-chromium-1440,desktop-webkit-1440 \
  --output-dir=../evidence/before/self-test
npx eslint tests/e2e/layout-stability*.mjs tests/e2e/layout-stability*.test.ts tests/e2e/web-targets-geometry.mjs
npx vitest run tests/e2e-web-geometry.test.ts tests/e2e/layout-stability*.test.ts
```

The probe checks opaque boot coverage, delayed seeded content, and a stable page.
It then inserts a banner, loading text, and a spinner.
It hides and restores content.
The check fails unless both engines detect these changes.
Chromium must also report positive CLS.
WebKit must report CLS as `unsupported`.

## BEFORE and AFTER

```sh
node tests/e2e/layout-stability.mjs \
  --stack-env=../local/local-stack.env --state=../local/tests/e2e-state.json \
  --build-sha=725fa91363c7c0fb858c2647892136dd847f6146 \
  --latency-profile=seeded,slow --workers=4 --observe-ms=1000 \
  --label=before --output-dir=../evidence/before

node tests/e2e/layout-stability.mjs --notice-navigation \
  --stack-env=../local/local-stack.env --state=../local/tests/e2e-state.json \
  --targets=iphone-webkit-390-standalone,desktop-chromium-1440 \
  --build-sha=725fa91363c7c0fb858c2647892136dd847f6146 \
  --latency-profile=seeded --cycles=10 --workers=2 \
  --label=before --output-dir=../evidence/before
```

For AFTER, rebuild the fixed app with its SHA.
Keep the same seed, options, browser versions, and harness files.
Change `--build-sha`, `--label`, and `--output-dir`.
Use `--help` and `--list` for narrower reruns.

## Measurements

| Metric | Chromium | WebKit |
| --- | --- | --- |
| CLS | LayoutShift entries; session windows; excludes recent input | Unsupported |
| Element displacement | Visible DOM geometry samples | Visible DOM geometry samples |
| Blank frames after content | Animation frame samples; route paint history | Animation frame samples; route paint history |
| Disappear and reappear | Selector and text identity | Selector and text identity |
| Loading text and duration | Visible text regex | Visible text regex |
| Spinners and duration | Progressbar role and ActivityIndicator markers | Progressbar role and ActivityIndicator markers |
| Stable layout time | 500 ms without content or position changes | Same |
| Empty notice | Visible text on Home | Same |

Geometry samples rAF, mutations, resizes, and a 50 ms timer.
Displacement uses CSS pixels.
The sweep enables normal motion.
It excludes displacement during 500 ms after input and 150 ms after scroll.
Blank-frame and notice checks remain active.
The recorder follows up to 200 visible headings, landmarks, controls, rows, and text blocks.
It cannot prove stability between samples or below the viewport.
Video accompanies each surface.

Cold contexts contain only the local auth session and selected-league identity.
All content caches and service workers start empty.
Refresh keeps localStorage and service-worker CacheStorage.
Playwright routing disables the HTTP cache.
API delays use a seeded hash of method, normalized URL, and request occurrence.
The hash replaces fixture UUIDs, so recreated fixtures keep the same delay sequence.
Service-worker fetches bypass Playwright routes.
A fetch wrapper applies the same delay before controlled API calls reach the worker.
The wrapper marks requests to prevent a second route delay.
Each request records its delay mechanism.
The report stores each injected delay.

Standalone mode uses the existing iPhone helper.
It does not test physical installation or iOS background suspension.
Tab return switches pages and injects visibility and focus events.
Reconnect keeps the browser offline for 5.1 seconds.
In-app navigation uses visible controls.
Missing controls produce explicit `NOT_RUN` cells.
History captures include the round trip through the other screen.
Raw frame records include the route for attribution.

A failed cell records metrics, raw frame data, screenshots, and video references.
Displacement fails above two CSS pixels; smaller values remain in the report.
Any positive CLS, loading duration, spinner duration, blank frame, or reappearance fails.
FAIL can also mean an assertion or driver error; inspect its reason.
An unfinished request alone is diagnostic, not a visible-layout failure.
Observation still waits for API quiet or the existing timeout.
A screenshot at completion can miss a brief failure; inspect its video and timed frame events.
`null` stability means content never arrives or changes continue at capture end.
A zero with no measured content is never treated as success.

The recorder excludes content behind the opaque, full-screen boot shell.
That content has DOM geometry but has not reached the user.
Frames record `bootCovered` while the shell covers the app.
When Paint Timing is supported, geometry waits for the first-contentful-paint entry.
The first visible animation frame is a fallback only when Paint Timing is unsupported.
The native Chromium CLS calculation remains unchanged.
Surfaces with expected seed text must show that text before observation can finish early.
The existing timeout still applies, and sampling continues throughout the wait.
A loading accessibility label alone does not prove a visible spinner.
Spinner measurements require a progressbar role or ActivityIndicator marker.
The self-test includes a static busy region to enforce this distinction.
Each scenario reports only script errors raised during that scenario.
An earlier error remains in its own raw capture.

## Prepare another AFTER build

Keep the base directory and its `dist` intact.
Create a separate directory for each release SHA.
Run this archive block locally, with a full commit SHA.
The archive filter excludes every `.env*` path, including tracked files.

```sh
AFTER_SHA=62e4304f4fb1a8d4bc3f16adf6d8e9e52470148a
EVIDENCE=/Users/michaelchen/.cache/supervise/tasks/t_04935f0d/evidence/sweep
git -C /Users/michaelchen/Projects/Apps/pancake-t_04935f0d archive "$AFTER_SHA" | \
  python3 -c 'import sys,tarfile
source=tarfile.open(fileobj=sys.stdin.buffer,mode="r|")
target=tarfile.open(fileobj=sys.stdout.buffer,mode="w|gz")
for item in source:
    parts=item.name.split("/")
    if any(p.startswith(".env") or p in {".git","node_modules","dist",".expo"} for p in parts): continue
    target.addfile(item,source.extractfile(item) if item.isfile() else None)
target.close()' > "$EVIDENCE/after-source-$AFTER_SHA.tar.gz"
rsync -a -e /Users/michaelchen/.cache/supervise/tasks/t_04935f0d/ssh-task \
  "$EVIDENCE/after-source-$AFTER_SHA.tar.gz" mini:pancake-t_04935f0d/lanes/sweep/
```

Use the capacity check before each install, stack start, build, or browser run.
Run the following blocks separately through the approved SSH wrapper.
Set `AFTER_SHA` to the same SHA in each remote shell.

```sh
. ~/pancake-t_04935f0d/env.sh
AFTER_SHA=62e4304f4fb1a8d4bc3f16adf6d8e9e52470148a
cd ~/pancake-t_04935f0d/lanes/sweep
mkdir -p "after-$AFTER_SHA/repo"
tar -xzf "after-source-$AFTER_SHA.tar.gz" -C "after-$AFTER_SHA/repo"
cd "after-$AFTER_SHA/repo"
npm ci --no-audit --no-fund
python3 - <<'PY'
from pathlib import Path
import re
p = Path('supabase/config.toml')
s = re.sub(r'^project_id = .*', 'project_id = "pt0493sweep"', p.read_text(), flags=re.M)
p.write_text(s.replace('543', '561'))
PY
```

Copy the latest owned harness files from the local checkout after extraction.
Use the same harness files for both builds when a measurement rule changes.

```sh
rsync -a -e /Users/michaelchen/.cache/supervise/tasks/t_04935f0d/ssh-task \
  tests/e2e/layout-stability*.mjs tests/e2e/layout-stability*.test.ts \
  tests/e2e/web-targets-geometry.mjs \
  "mini:pancake-t_04935f0d/lanes/sweep/after-$AFTER_SHA/repo/tests/e2e/"
```

```sh
. ~/pancake-t_04935f0d/env.sh
AFTER_SHA=62e4304f4fb1a8d4bc3f16adf6d8e9e52470148a
cd ~/pancake-t_04935f0d/lanes/sweep/after-$AFTER_SHA/repo
export SUPABASE_GO_BINARY=$HOME/pancake-t_04935f0d/lanes/sweep/tools/supabase-go
supabase start -x studio,imgproxy,vector,logflare,supavisor
node tests/e2e/layout-stability-local.mjs --output-dir=../../local --seed=true
```

```sh
. ~/pancake-t_04935f0d/env.sh
AFTER_SHA=62e4304f4fb1a8d4bc3f16adf6d8e9e52470148a
cd ~/pancake-t_04935f0d/lanes/sweep/after-$AFTER_SHA/repo
set -a
. ../../local/local-stack.env
set +a
PANCAKE_RELEASE_SHA="$AFTER_SHA" EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 npm run build:web:release
```

Start these servers only when this lane has no existing server on the same port.
Check each saved PID's command before stopping or replacing it.

```sh
mkdir -p ../../evidence/after-$AFTER_SHA
nohup ../../tools/supabase-go functions serve --env-file ../../local/functions.env \
  > ../../evidence/after-$AFTER_SHA/functions.log 2>&1 < /dev/null &
echo $! > ../../local/functions.pid
nohup node tests/e2e/static-web-server.mjs --root=dist --port=56190 \
  > ../../evidence/after-$AFTER_SHA/server.log 2>&1 < /dev/null &
echo $! > ../../local/server.pid
```

Run the full sweep and notice mode as separate capacity-gated jobs.
Use the same environment, working directory, and `AFTER_SHA` as above.

```sh
node tests/e2e/layout-stability.mjs \
  --stack-env=../../local/local-stack.env --state=../../local/tests/e2e-state.json \
  --build-sha="$AFTER_SHA" --latency-profile=seeded,slow --seed=493 \
  --workers=4 --observe-ms=1000 --label=after --output-dir=../../evidence/after-$AFTER_SHA
```

```sh
node tests/e2e/layout-stability.mjs --notice-navigation \
  --stack-env=../../local/local-stack.env --state=../../local/tests/e2e-state.json \
  --build-sha="$AFTER_SHA" --latency-profile=seeded --seed=493 --cycles=10 --workers=4 \
  --targets=iphone-webkit-390-standalone,iphone-webkit-393-standalone,desktop-chromium-1440,desktop-webkit-1440 \
  --label=after --output-dir=../../evidence/after-$AFTER_SHA
```

## Compare completed reports

Copy all referenced raw captures before running this command.
The helper rejects mismatched surface, target, scenario, or latency combinations.
It writes comparison tables and per-failure facts for source review.
`--partial` permits a clearly marked progress report while a sweep runs.

```sh
node tests/e2e/layout-stability-analysis.mjs \
  --before-dir=/absolute/evidence/sweep/before \
  --after-dir=/absolute/evidence/sweep/after \
  --output-dir=/absolute/evidence/sweep
```

Read each failure's raw capture and affected route before assigning its source component.
Browser history captures can include a failure on the other screen.
Do not assign that failure to the destination screen without checking the route.

Keep a corrected rerun inside each build's evidence directory.
This command replaces matching cells and keeps the original reports and raw captures.
It rejects another release, another bundle, incomplete runs, and duplicate cells.

```sh
node tests/e2e/layout-stability-merge.mjs \
  --output-dir=/absolute/evidence/sweep/before \
  --rerun-dir=/absolute/evidence/sweep/before/reruns/corrected
```

## Recalculate CLS from saved evidence

The raw browser records retain every LayoutShift entry and its input flag.
This command reapplies the tested session-window calculation without rerunning browsers.
It updates both reports and their referenced raw captures.

```sh
node tests/e2e/layout-stability-cls.mjs --output-dir=../evidence/before
```

## Cleanup

Stop only the PIDs saved by this lane.
Do not stop the shared VM.

```sh
SWEEP_ROOT=$HOME/pancake-t_04935f0d/lanes/sweep
for service in functions server; do
  service_pid=$(cat "$SWEEP_ROOT/local/$service.pid")
  service_command=$(ps -p "$service_pid" -o command=)
  case "$service:$service_command" in
    functions:*'supabase-go functions serve'*) kill "$service_pid" ;;
    server:*'node tests/e2e/static-web-server.mjs --root=dist --port=56190'*) kill "$service_pid" ;;
    functions:|server:) ;;
    *) echo "Saved PID no longer matches $service"; exit 1 ;;
  esac
done
"$SWEEP_ROOT/tools/supabase-go" stop --project-id pt0493sweep
```

Copy evidence back without copying the separate `local` directory.
That directory contains synthetic passwords and generated local stack keys.
