# Layout stability sweep

This harness measures the release app in headless Chromium and WebKit.
Run it with `npm run e2e:layout-stability -- FLAGS`.
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

## Stack setup

Use an isolated local project with its own project ID and configured loopback ports.
Install the pinned Playwright Chromium and WebKit browsers before this recipe.
The commands below use the default 561xx ports.
Use the port flags above for another assigned stack.
Keep generated keys and seed state in `../local`, outside the checkout.

```sh
supabase start -x studio,imgproxy,vector,logflare,supavisor
node tests/e2e/layout-stability-local.mjs --output-dir=../local --seed=true
mkdir -p ../evidence/before
nohup supabase functions serve --env-file ../local/functions.env \
  > ../evidence/before/functions.log 2>&1 < /dev/null &
echo $! > ../local/functions.pid
set -a
. ../local/local-stack.env
set +a
PANCAKE_RELEASE_SHA="$(git rev-parse HEAD)" \
  EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 npm run build:web:release
nohup node tests/e2e/static-web-server.mjs --root=dist --port=56190 \
  > ../evidence/before/server.log 2>&1 < /dev/null &
echo $! > ../local/server.pid
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
  --build-sha="$(git rev-parse HEAD)" \
  --latency-profile=seeded,slow --workers=4 --observe-ms=1000 \
  --label=before --output-dir=../evidence/before

node tests/e2e/layout-stability.mjs --notice-navigation \
  --stack-env=../local/local-stack.env --state=../local/tests/e2e-state.json \
  --targets=iphone-webkit-390-standalone,desktop-chromium-1440 \
  --build-sha="$(git rev-parse HEAD)" \
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

## Compare releases

Keep each release in its own checkout with its own `dist` directory.
Build each release with `PANCAKE_RELEASE_SHA` set to its full commit SHA.
Use the same harness, seed, ports, browser versions, and measurement options for both runs.
Keep each run in a separate evidence directory.

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

Stop only the server processes recorded in `../local/functions.pid` and `../local/server.pid`.
Check each saved process command before stopping it.
Stop only the assigned Supabase project by its configured project ID.
Keep `../local` out of copied evidence; it contains generated keys and synthetic passwords.
