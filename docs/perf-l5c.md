# L5c API traffic

Private project: `pt4bafablerq`. Ports: `633xx`. Baseline: release 2.9.1, `ec739102`. No production endpoints were used.

The bench restores the October 28 production-shaped backup, applies the repository migrations, and adds the existing iOS fixture league. Cron is disabled. Database HTTP and Edge fetches are fenced to the private stack. Browser requests are restricted to the private origin. Public NBA images are recorded separately in the lane folder.

The browser is a separate agent-browser Chromium session at 390 × 844. Agent-browser opens routes, presses controls, enters search text, and scrolls the player list. Playwright observes responses and connects to that automation browser through CDP. Agent-browser captures screenshots in the first full walk for each build and in every idle capture. Later walks repeat the same measured actions.

Cold means the app data cache is empty. Warm tab cases leave and return through the app's navigation or section controls with saved data. Other screens reopen their URL. The harness checks selected section tabs. Setup navigation is outside the measurement windows. Database buffers are not flushed. Idle captures use a quiet fixture with cron disabled. Live-game hint traffic and the future Broadcast transport are not replayed. Static boot files are excluded. HTTP responses from auth, REST, and the app API are counted, including headshots and performance beacons. Raw bytes are decoded response bodies. Compressed bytes are encoded response body bytes recorded by the private capture server, matched to Chromium responses by path, method, and completion time. HTTP headers and chunk framing are excluded. Chromium transfer sizes and recompressed gzip sizes are also saved in the JSON evidence. WebSocket frames are excluded from HTTP totals; redacted realtime traces remain in the evidence. The original stack evidence is retained as `traffic-evidence-1f36/`.

DB time comes from `pg_stat_statements` deltas around each screen or action. It includes top-level PostgREST data queries and auth SELECT lookups. Pool metadata queries, schema-cache introspection, and realtime server work are excluded. Nested statements are retained as evidence and are not counted twice. RPC detail uses total execution time divided by calls. These are bench timings, not production latency estimates.

The first walk was a pilot. It found missing local image fixtures and a version baseline race. The measured walks use fixed image fixtures and alternate baseline and candidate builds. Each build has three complete walks. Request counts and bytes are the primary acceptance signals. Timing differences smaller than the repeated-run spread are treated as noise.

The initial baseline has no interval loop in `useLeagueVersion` or `useScreenView`. Hidden and offline reads are already gated. Version-only fallback reads remain on activation, reconnect, explicit refresh, and mutation completion. The initial traffic trial added no timer. The game-night recovery follow-up below adds a live-game guard.

The client already shares concurrent screen reads and league version checks. Players already loads 20 rows per page, with a server maximum of 50. Activity, trades, and player game logs already have bounded reads. These mechanisms were retained.

The initial client trial keeps the latest trusted version hint as a validation boundary. It skips ordinary HTTP version validation only while hints are connected and the applied counter has caught up. Subscribers with saved data still read complete history over HTTP. An empty screen cache can start at the connected baseline before its first data read. A regression test reproduced a false Players invalidation when an incomplete startup hint was replayed. That part of the first trial was removed. A disconnect clears that authority. Missing version hints keep the HTTP path. Explicit refreshes and mutation completion still check HTTP. Existing topic filtering and conservative recovery for missed changes remain in place. The follow-up adds a time limit to this authority.

This uses the existing `notifyLeagueChange` and `setLeagueChangesConnected` boundary. L1 can change the hint transport to Broadcast without changing this contract. No transport code was changed. Old servers without version hints retain HTTP validation. The previous client was also walked against the new server response.

Conditional 304 support would require the Edge view handler, which is outside this lane's allowed paths. Connected, unchanged views instead make no version request. The disconnected path already uses a version-only lookup and reuses unchanged cached data. No 304 change was kept.

The server returns an empty `ownedMap` for free-agent reads without explicit support-player IDs. These results contain only unowned players. Every other response field remains identical. All-player, rostered, mine, waiver, and claim-editor reads retain their previous maps. Twelve private SQL response comparisons cover these cases. Three interleaved Players walks saved exactly 97,023 raw bytes and 16,813 compressed bytes each, with 18 requests on both sides. SQL time was within the repeated-run spread. The release 2.9.1 client completed the same Players controls against the new response.

The walk measures 28 routes cold and warm, plus 37 actions. Actions cover seven days and both arrows on Home and Matchup, auto-set options and the manual lineup editor, roster player actions, Players search and scrolling, five filter changes, trade asset selection and both review flows, and player game-log, news, and league-history sections. Settings and notification settings are opened. Final trade submission, destructive settings, and notification delivery are not triggered.

SQL files changed:

- `supabase/sql/functions/by-name/public/view_players.sql`
- `supabase/migrations/20261214002300_l5c_players_response.sql`

The migration preserves the signature, owner, privileges, and invoker security. Its exact four-statement fingerprint was recorded after applying it on the private database. The security catalog keeps its previous observations and adds the migration source hash and candidate version. No production history was queried.

The first retained client change was committed at 23:03 UTC, after the 23:00 UTC shipping cutoff. No push, PR, deployment, or CI run was made.

The initial traffic candidate passed the full Vitest suite: 4,708 passed and 48 skipped across 510 files. Lint, both TypeScript checks, knip, canonical function-source checks, and the migration-attestation check passed. The private migration applied successfully. Earlier failures caused by the new migration's missing release metadata were fixed by recording its private-stack fingerprint and release note.

Rejected captures are retained with timestamp suffixes. Pilots with missing image fixtures, transient private auth/API failures, or a database counter reset are excluded. A private database restart invalidated the first Matchup idle capture. It was repeated.

Evidence stays in `~/pancake-t_4ba51e0d/lanes/fable-l5c/` on the mini. `request-summary.json` contains per-screen samples, per-operation DB means, compressed sizes, screenshot comparisons, and idle minute captures. Raw reports and screenshots are under `requests/`.

Run the tools from the private mini checkout with `PERF_LAB_ON_MINI=1`, `PERF_LAB_LANE=fable-l5c`, `PERF_LAB_PROJECT=pt4bafablerq`, and `PERF_LAB_PORT_PREFIX=633`. Use the supplied Docker socket and browser directory. Copy the backup into the lane's `backup/` folder before starting.

1. Remove any previous lane `stop` marker. `node tests/e2e/l5c-stack.mjs` restores, seeds, builds, and serves the baseline. It waits for the lane's `stop` file.
2. Save the baseline export as `before-export`. Run `node tests/e2e/l5c-assets.mjs` before measured walks.
3. Build the candidate with the same `buildWeb` helper. Save it as `after-export` and restore the baseline served folder.
4. `node tests/e2e/l5c-series.mjs` alternates three baseline and three candidate walks. `L5C_COMPARE_SQL=1` also alternates the original function from the lane's `view_players-before.sql` and the candidate canonical function. Original SQL can be saved with `git show ec739102:supabase/sql/functions/by-name/public/view_players.sql`. Earlier and rejected reports are retained with timestamp suffixes.
5. Run `node tests/e2e/l5c-requests.mjs before 1 idle-home` and `idle-matchup` with the baseline served. Repeat with `after` and the candidate served. Each capture lasts ten minutes.
6. `node tests/e2e/l5c-trim.mjs` compares response contracts and repeats the Players controls with each function, then tests the previous client. `node tests/e2e/l5c-report.mjs` writes the summary and Markdown tables. Touch the lane's `stop` file to stop the stack and remove backup copies.

## L5c release order

Migration `20261214002300_l5c_players_response.sql` only omits unused ownership entries from free-agent responses. It keeps the function signature and every other response field. Explicit support-player reads retain ownership entries. Release 2.9.1 was exercised against this migration. The client cache change works with the previous server. Either side can ship first. No Edge change is required.

## Measurements

Initial traffic candidate artifact: `70fba7e0`. Application files through `1f36ed77` match this artifact. The recovery follow-up below measures the later client. These tables retain the initial traffic results.

Three final pairs alternate baseline and candidate. Each pair saved 25, 24, and 24 requests respectively. Every pair saved 22 version checks. Median paired savings are 24 requests, 161,310 raw bytes, and 30,600 compressed bytes. Both request and byte gains exceed the repeated-run spread. DB totals fell in every pair, but their spread is large. No per-RPC speedup is claimed.

The totals below use the median of each build’s three walks. The next table subtracts within each adjacent pair.

| Build | Requests / walk | Raw B / walk | Compressed B / walk | DB ms / walk | Version checks / walk |
|---|---:|---:|---:|---:|---:|
| before | 297 | 3,528,124 | 2,198,959 | 910.88 | 36 |
| after | 272 | 3,343,740 | 2,167,200 | 826.41 | 14 |

| Pair | Fewer requests | Raw B saved | Compressed B saved | DB ms saved | Fewer version checks |
|---|---:|---:|---:|---:|---:|
| 1 | 25 | 184,384 | 31,759 | 133.26 | 22 |
| 2 | 24 | 161,039 | 27,913 | 64.18 | 22 |
| 3 | 24 | 161,310 | 30,600 | 37.73 | 22 |

The isolated SQL trial kept the client fixed and alternated the two function bodies. Each ten-state Players walk made 18 requests. Raw bytes fell from 544,318 to 447,295, and compressed bytes from 203,465 to 186,652 in every pair. This saves 17.8% raw bytes and 8.3% compressed bytes. SQL timing remained within noise.

All 95 screen and idle screenshot pairs were compared. 94 are byte-for-byte identical. The trade-review expiration time advances by three minutes between captures; its data and layout are unchanged. Home, Players, the lineup editor, standings, and trade review were also inspected visually.

Blocked attempts to the Google log and startup diagnostic endpoints remain in the raw reports. The origin allowlist denied them. They are outside the API totals.

The table reports one screen open or one control action. Counts and sizes are medians of three samples per build. The two idle rows show rates per minute over a ten-minute capture, with one capture per build.

| Screen | State | n before/after | Requests before → after | Raw B before → after | Compressed B before → after | DB ms before → after |
|---|---|---:|---:|---:|---:|---:|
| idle-home | idle | 1/1 | 0.10 → 0.10 | 1.10 → 1.10 | 1.50 → 1.50 | 0.18 → 0.19 |
| idle-matchup | idle | 1/1 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| home | cold | 3/3 | 3.00 → 3.00 | 28457 → 28457 | 8990 → 8990 | 16.43 → 17.66 |
| home | warm | 3/3 | 2.00 → 0.00 | 37256 → 0.00 | 6584 → 0.00 | 8.92 → 0.00 |
| matchup | cold | 3/3 | 3.00 → 3.00 | 41861 → 41861 | 9118 → 9118 | 26.27 → 25.92 |
| matchup | warm | 3/3 | 3.00 → 2.00 | 3494 → 3465 | 3498 → 3465 | 1.47 → 0.86 |
| lineup | cold | 3/3 | 5.00 → 4.00 | 20072 → 20043 | 8830 → 8797 | 9.46 → 5.08 |
| lineup | warm | 3/3 | 4.00 → 4.00 | 17487 → 17487 | 6282 → 6282 | 2.42 → 2.00 |
| roster | cold | 3/3 | 3.00 → 3.00 | 29616 → 29616 | 7288 → 7288 | 9.94 → 12.94 |
| roster | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| moves | cold | 3/3 | 3.00 → 3.00 | 29616 → 29616 | 7288 → 7288 | 10.02 → 4.94 |
| moves | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| players | cold | 3/3 | 6.00 → 6.00 | 117153 → 84812 | 63643 → 58065 | 30.41 → 38.89 |
| players | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.17 → 0.00 |
| player | cold | 3/3 | 3.00 → 3.00 | 9131 → 9131 | 5181 → 5181 | 6.38 → 6.36 |
| player | warm | 3/3 | 3.00 → 2.00 | 3494 → 3465 | 3498 → 3465 | 1.36 → 0.74 |
| trades | cold | 3/3 | 4.00 → 4.00 | 11994 → 11994 | 6011 → 6011 | 14.99 → 11.90 |
| trades | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.15 → 0.00 |
| compose | cold | 3/3 | 12.00 → 12.00 | 82092 → 82092 | 59764 → 59764 | 11.96 → 12.00 |
| compose | warm | 3/3 | 13.00 → 12.00 | 94356 → 68205 | 60823 → 57000 | 13.27 → 6.07 |
| analyzer | cold | 3/3 | 14.00 → 14.00 | 38079 → 38079 | 38079 → 38079 | 4.72 → 5.64 |
| analyzer | warm | 3/3 | 9.00 → 9.00 | 27402 → 27402 | 27402 → 27402 | 3.62 → 4.31 |
| league | cold | 3/3 | 3.00 → 3.00 | 7721 → 7721 | 4854 → 4854 | 9.14 → 9.05 |
| league | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| standings | cold | 3/3 | 3.00 → 3.00 | 7721 → 7721 | 4854 → 4854 | 9.16 → 7.48 |
| standings | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| activity | cold | 3/3 | 5.00 → 5.00 | 33230 → 33230 | 10028 → 10028 | 11.82 → 9.51 |
| activity | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| picks | cold | 3/3 | 3.00 → 3.00 | 31124 → 31124 | 7294 → 7294 | 8.38 → 9.18 |
| picks | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| schedule | cold | 3/3 | 3.00 → 3.00 | 6046 → 6046 | 3837 → 3837 | 1.76 → 1.78 |
| schedule | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.12 → 0.00 |
| draft | cold | 3/3 | 3.00 → 3.00 | 7648 → 7648 | 4782 → 4782 | 7.68 → 8.20 |
| draft | warm | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.10 → 0.00 |
| bracket | cold | 3/3 | 4.00 → 4.00 | 3533 → 3533 | 3533 → 3533 | 1.87 → 1.11 |
| bracket | warm | 3/3 | 4.00 → 4.00 | 3533 → 3533 | 3533 → 3533 | 1.68 → 1.89 |
| settings | cold | 3/3 | 3.00 → 3.00 | 9896 → 9896 | 5198 → 5198 | 7.97 → 8.51 |
| settings | warm | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| profile | cold | 3/3 | 3.00 → 3.00 | 3900 → 3900 | 3701 → 3701 | 2.00 → 1.96 |
| profile | warm | 3/3 | 3.00 → 3.00 | 3900 → 3900 | 3701 → 3701 | 1.96 → 1.70 |
| notifications | cold | 3/3 | 4.00 → 4.00 | 3928 → 3928 | 3733 → 3733 | 2.50 → 1.89 |
| notifications | warm | 3/3 | 4.00 → 4.00 | 3928 → 3928 | 3733 → 3733 | 2.08 → 1.69 |
| commissioner-settings | cold | 3/3 | 8.00 → 8.00 | 9474 → 9474 | 9474 → 9474 | 3.55 → 2.82 |
| commissioner-settings | warm | 3/3 | 8.00 → 8.00 | 9474 → 9474 | 9474 → 9474 | 4.11 → 3.78 |
| team-roster | cold | 3/3 | 4.00 → 4.00 | 40191 → 40191 | 8192 → 8192 | 4.95 → 10.85 |
| team-roster | warm | 3/3 | 3.00 → 3.00 | 15729 → 15729 | 4524 → 4524 | 1.95 → 1.40 |
| claim-player | cold | 3/3 | 4.00 → 3.00 | 52509 → 52480 | 12256 → 12223 | 33.39 → 34.17 |
| claim-player | warm | 3/3 | 3.00 → 3.00 | 15729 → 15729 | 4524 → 4524 | 2.25 → 1.46 |
| timeline | cold | 3/3 | 3.00 → 3.00 | 4139 → 4139 | 4139 → 4139 | 7.34 → 2.20 |
| timeline | warm | 3/3 | 3.00 → 3.00 | 4139 → 4139 | 4139 → 4139 | 5.30 → 2.19 |
| dynasty | cold | 3/3 | 12.00 → 12.00 | 636068 → 636068 | 636068 → 636068 | 92.10 → 90.72 |
| dynasty | warm | 3/3 | 12.00 → 12.00 | 636068 → 636068 | 636068 → 636068 | 101 → 82.60 |
| draft-launcher | cold | 3/3 | 10.00 → 10.00 | 102917 → 102917 | 60866 → 60866 | 9.46 → 7.96 |
| draft-launcher | warm | 3/3 | 9.00 → 9.00 | 65154 → 65154 | 53949 → 53949 | 2.54 → 2.25 |
| auction-room | cold | 3/3 | 4.00 → 3.00 | 36027 → 35998 | 10210 → 10177 | 7.19 → 7.00 |
| auction-room | warm | 3/3 | 3.00 → 3.00 | 15729 → 15729 | 4524 → 4524 | 1.88 → 1.15 |
| rookie-room | cold | 3/3 | 9.00 → 8.00 | 90172 → 90143 | 59330 → 59297 | 7.08 → 7.36 |
| rookie-room | warm | 3/3 | 8.00 → 8.00 | 64644 → 64644 | 53439 → 53439 | 2.53 → 1.68 |
| home-day-0 | action | 3/3 | 1.00 → 1.00 | 21257 → 21257 | 5027 → 5027 | 13.77 → 7.80 |
| home-day-1 | action | 3/3 | 1.00 → 1.00 | 19564 → 19564 | 4741 → 4741 | 7.28 → 7.09 |
| home-day-2 | action | 3/3 | 1.00 → 1.00 | 38051 → 38051 | 6297 → 6297 | 9.59 → 7.50 |
| home-day-3 | action | 3/3 | 2.00 → 2.00 | 37256 → 37256 | 6582 → 6584 | 8.64 → 7.63 |
| home-day-4 | action | 3/3 | 1.00 → 1.00 | 24034 → 24034 | 5439 → 5439 | 7.74 → 7.29 |
| home-day-5 | action | 3/3 | 1.00 → 1.00 | 23024 → 23024 | 5289 → 5289 | 8.76 → 7.81 |
| home-day-6 | action | 3/3 | 1.00 → 1.00 | 22016 → 22016 | 5141 → 5141 | 7.13 → 7.16 |
| home-previous | action | 3/3 | 1.00 → 1.00 | 30405 → 30405 | 5087 → 5087 | 14.19 → 13.12 |
| home-next | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| matchup-day-0 | action | 3/3 | 1.00 → 1.00 | 34421 → 34421 | 5152 → 5152 | 18.82 → 13.82 |
| matchup-day-1 | action | 3/3 | 1.00 → 1.00 | 29742 → 29742 | 4835 → 4835 | 13.35 → 13.49 |
| matchup-day-2 | action | 3/3 | 1.00 → 1.00 | 67364 → 67364 | 6501 → 6501 | 21.02 → 15.35 |
| matchup-day-3 | action | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.16 → 0.00 |
| matchup-day-4 | action | 3/3 | 1.00 → 1.00 | 37672 → 37672 | 5570 → 5570 | 17.63 → 13.34 |
| matchup-day-5 | action | 3/3 | 1.00 → 1.00 | 34882 → 34882 | 5407 → 5407 | 18.16 → 12.85 |
| matchup-day-6 | action | 3/3 | 1.00 → 1.00 | 32098 → 32098 | 5223 → 5223 | 13.65 → 12.75 |
| matchup-previous | action | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.16 → 0.00 |
| matchup-next | action | 3/3 | 1.00 → 0.00 | 29.00 → 0.00 | 33.00 → 0.00 | 0.11 → 0.00 |
| lineup-options | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| edit-lineup | action | 3/3 | 3.00 → 2.00 | 16607 → 16578 | 5365 → 5332 | 3.10 → 2.90 |
| roster-player-actions | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| players-search | action | 3/3 | 1.00 → 1.00 | 39173 → 6832 | 7900 → 2245 | 13.10 → 12.74 |
| players-scroll | action | 3/3 | 7.00 → 6.00 | 143537 → 111167 | 91933 → 86320 | 19.74 → 21.05 |
| players-filters | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| players-filter-availability | action | 3/3 | 1.00 → 1.00 | 74595 → 74595 | 8776 → 8776 | 19.55 → 13.48 |
| players-filter-position | action | 3/3 | 1.00 → 1.00 | 46675 → 46675 | 8021 → 8021 | 12.47 → 12.18 |
| players-filter-health | action | 3/3 | 1.00 → 1.00 | 44811 → 44811 | 7964 → 7964 | 21.71 → 12.31 |
| players-filter-game-today | action | 3/3 | 1.00 → 1.00 | 41092 → 41092 | 7957 → 7957 | 11.77 → 22.20 |
| players-filter-experience | action | 3/3 | 1.00 → 1.00 | 37309 → 37309 | 7302 → 7302 | 7.88 → 8.51 |
| compose-select | action | 3/3 | 7.00 → 6.00 | 96188 → 69893 | 14745 → 10850 | 49.55 → 47.74 |
| compose-analyze | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| compose-request | action | 3/3 | 4.00 → 4.00 | 15488 → 15345 | 2963 → 2890 | 38.82 → 39.50 |
| compose-review | action | 3/3 | 1.00 → 1.00 | 158 → 158 | 158 → 158 | 0.02 → 0.03 |
| player-game-log | action | 3/3 | 1.00 → 1.00 | 3380 → 3380 | 1301 → 1301 | 1.26 → 1.27 |
| player-news | action | 3/3 | 1.00 → 1.00 | 2101 → 2101 | 868 → 868 | 0.94 → 0.88 |
| player-league-history | action | 3/3 | 1.00 → 1.00 | 2109 → 2109 | 870 → 870 | 0.84 → 0.99 |
| trade-review | action | 3/3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |

## RPC costs

Each row names the top-level PostgREST RPC or relation. Calls per run are averaged across the three walks. Idle RPC rows cover one ten-minute capture. DB ms per SQL call is total execution time divided by calls. Auth SELECT time is included in screen totals. Nested calls are not added again.

| Screen / state | RPC or relation | Calls per run before → after | DB ms per SQL call before → after |
|---|---|---:|---:|
| idle-home / idle | perf_beacons | 1.00 → 1.00 | 1.64 → 1.75 |
| idle-home / idle | league_members | 1.00 → 1.00 | 0.03 → 0.03 |
| home / cold | view_home | 1.00 → 1.00 | 15.35 → 17.32 |
| home / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.60 → 0.58 |
| home / cold | league_change_hints | 1.00 → 1.00 | 0.31 → 0.49 |
| home / cold | nba_games | 1.00 → 1.00 | 0.02 → 0.03 |
| matchup / cold | view_home | 1.00 → 1.00 | 8.42 → 8.24 |
| matchup / cold | view_lineup | 2.00 → 2.00 | 6.99 → 5.53 |
| matchup / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.48 → 0.82 |
| matchup / cold | league_change_hints | 1.00 → 1.00 | 0.25 → 0.29 |
| matchup / cold | view_standings | 1.00 → 1.00 | 3.87 → 3.65 |
| matchup / cold | get_matchup_forecast | 1.00 → 1.00 | 1.03 → 1.43 |
| matchup / cold | matchups | 1.00 → 1.00 | 0.64 → 0.62 |
| matchup / cold | nba_games | 1.00 → 1.00 | 0.02 → 0.02 |
| matchup / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.77 → 0.61 |
| matchup / warm | league_change_hints | 1.00 → 1.00 | 0.31 → 0.25 |
| lineup / cold | view_lineup | 1.00 → 1.00 | 7.47 → 4.14 |
| lineup / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.76 → 0.72 |
| lineup / cold | league_change_hints | 1.00 → 1.00 | 0.27 → 0.32 |
| lineup / cold | players | 1.00 → 1.00 | 0.06 → 0.06 |
| lineup / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.96 → 0.76 |
| lineup / warm | league_change_hints | 1.00 → 1.00 | 0.34 → 0.40 |
| lineup / warm | get_league_version | 1.00 → 1.00 | 0.83 → 0.87 |
| lineup / warm | players | 1.00 → 1.00 | 0.08 → 0.08 |
| roster / cold | view_roster | 1.00 → 1.00 | 7.61 → 12.13 |
| roster / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.66 → 0.66 |
| roster / cold | league_change_hints | 1.00 → 1.00 | 0.37 → 0.28 |
| moves / cold | view_roster | 1.00 → 1.00 | 9.28 → 4.08 |
| moves / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.51 → 0.67 |
| moves / cold | league_change_hints | 1.00 → 1.00 | 0.30 → 0.30 |
| players / cold | view_players | 1.00 → 1.00 | 29.14 → 37.92 |
| players / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.59 → 0.59 |
| players / cold | league_change_hints | 1.00 → 1.00 | 0.29 → 0.32 |
| player / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.56 → 0.65 |
| player / cold | league_change_hints | 1.00 → 1.00 | 0.28 → 0.36 |
| player / cold | view_player | 1.00 → 1.00 | 5.49 → 5.98 |
| player / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.85 → 0.56 |
| player / warm | league_change_hints | 1.00 → 1.00 | 0.40 → 0.27 |
| trades / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.44 → 0.63 |
| trades / cold | view_trades | 1.00 → 1.00 | 14.40 → 11.53 |
| trades / cold | league_change_hints | 1.00 → 1.00 | 0.26 → 0.36 |
| trades / cold | players | 1.00 → 1.00 | 0.05 → 0.04 |
| compose / cold | view_roster | 1.00 → 1.00 | 7.46 → 6.13 |
| compose / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.53 → 0.69 |
| compose / cold | league_change_hints | 1.00 → 1.00 | 0.39 → 0.48 |
| compose / cold | league_members,profiles | 1.00 → 1.00 | 0.55 → 0.60 |
| compose / cold | roster_players,players | 2.00 → 2.00 | 0.45 → 0.71 |
| compose / cold | leagues,league_seasons | 1.00 → 1.00 | 0.35 → 0.49 |
| compose / cold | draft_picks,league_members | 1.00 → 1.00 | 0.76 → 0.60 |
| compose / cold | league_seasons | 1.00 → 1.00 | 0.23 → 0.21 |
| compose / cold | drafts,league_seasons | 1.00 → 1.00 | 0.29 → 0.28 |
| compose / cold | v_player_avg_fantasy_points | 1.00 → 1.00 | 0.38 → 0.37 |
| compose / cold | mv_player_season_averages | 1.00 → 1.00 | 0.15 → 0.16 |
| compose / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.73 → 0.79 |
| compose / warm | league_change_hints | 1.00 → 1.00 | 0.43 → 0.42 |
| compose / warm | get_league_version | 1.00 → 1.00 | 0.57 → 0.72 |
| compose / warm | league_members,profiles | 1.00 → 1.00 | 0.55 → 0.84 |
| compose / warm | roster_players,players | 2.00 → 2.00 | 0.62 → 0.63 |
| compose / warm | leagues,league_seasons | 1.00 → 1.00 | 0.52 → 0.42 |
| compose / warm | draft_picks,league_members | 1.00 → 1.00 | 0.36 → 0.35 |
| compose / warm | league_seasons | 1.00 → 1.00 | 0.25 → 0.29 |
| compose / warm | drafts,league_seasons | 1.00 → 1.00 | 0.36 → 0.30 |
| compose / warm | v_player_avg_fantasy_points | 1.00 → 1.00 | 0.37 → 0.48 |
| compose / warm | mv_player_season_averages | 1.00 → 1.00 | 0.18 → 0.18 |
| analyzer / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.52 → 0.82 |
| analyzer / cold | league_change_hints | 1.00 → 1.00 | 0.29 → 0.28 |
| analyzer / cold | league_members,profiles | 1.00 → 1.00 | 0.43 → 0.80 |
| analyzer / cold | roster_players,players | 2.00 → 2.00 | 0.40 → 0.69 |
| analyzer / cold | leagues,league_seasons | 2.00 → 2.00 | 0.26 → 0.48 |
| analyzer / cold | draft_picks,league_members | 2.00 → 2.00 | 0.43 → 0.50 |
| analyzer / cold | league_seasons | 1.00 → 1.00 | 0.20 → 0.38 |
| analyzer / cold | drafts,league_seasons | 2.00 → 2.00 | 0.27 → 0.36 |
| analyzer / cold | v_player_avg_fantasy_points | 1.00 → 1.00 | 0.32 → 0.56 |
| analyzer / cold | mv_player_season_averages | 1.00 → 1.00 | 0.09 → 0.14 |
| analyzer / warm | league_members,profiles | 1.00 → 1.00 | 0.48 → 0.85 |
| analyzer / warm | roster_players,players | 2.00 → 2.00 | 0.58 → 0.65 |
| analyzer / warm | leagues,league_seasons | 2.00 → 2.00 | 0.33 → 0.60 |
| analyzer / warm | draft_picks,league_members | 2.00 → 2.00 | 0.38 → 0.46 |
| analyzer / warm | drafts,league_seasons | 2.00 → 2.00 | 0.26 → 0.42 |
| league / cold | view_league | 1.00 → 1.00 | 8.35 → 8.31 |
| league / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.47 → 0.78 |
| league / cold | league_change_hints | 1.00 → 1.00 | 0.41 → 0.26 |
| standings / cold | view_league | 1.00 → 1.00 | 8.19 → 6.62 |
| standings / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.57 → 0.64 |
| standings / cold | league_change_hints | 1.00 → 1.00 | 0.36 → 0.28 |
| activity / cold | view_league | 1.00 → 1.00 | 10.55 → 8.46 |
| activity / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.49 → 0.74 |
| activity / cold | league_change_hints | 1.00 → 1.00 | 0.36 → 0.33 |
| activity / cold | players | 2.00 → 2.00 | 0.07 → 0.07 |
| picks / cold | view_league | 1.00 → 1.00 | 7.18 → 8.55 |
| picks / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.64 → 0.77 |
| picks / cold | league_change_hints | 1.00 → 1.00 | 0.41 → 0.30 |
| schedule / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.54 → 0.62 |
| schedule / cold | league_change_hints | 1.00 → 1.00 | 0.27 → 0.27 |
| schedule / cold | view_league_schedule | 1.00 → 1.00 | 0.99 → 1.05 |
| draft / cold | view_league | 1.00 → 1.00 | 6.66 → 7.24 |
| draft / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.45 → 0.55 |
| draft / cold | league_change_hints | 1.00 → 1.00 | 0.41 → 0.32 |
| bracket / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.71 → 0.42 |
| bracket / cold | league_change_hints | 1.00 → 1.00 | 0.41 → 0.45 |
| bracket / cold | league_seasons | 1.00 → 1.00 | 0.35 → 0.23 |
| bracket / cold | matchups,league_members | 1.00 → 1.00 | 0.27 → 0.18 |
| bracket / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.76 → 0.85 |
| bracket / warm | league_change_hints | 1.00 → 1.00 | 0.45 → 0.33 |
| bracket / warm | league_seasons | 1.00 → 1.00 | 0.33 → 0.27 |
| bracket / warm | matchups,league_members | 1.00 → 1.00 | 0.32 → 0.34 |
| settings / cold | view_league | 1.00 → 1.00 | 7.08 → 7.24 |
| settings / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.73 → 0.92 |
| settings / cold | league_change_hints | 1.00 → 1.00 | 0.30 → 0.38 |
| profile / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.08 → 0.66 |
| profile / cold | league_change_hints | 1.00 → 1.00 | 0.33 → 0.43 |
| profile / cold | view_profile | 1.00 → 1.00 | 0.89 → 0.95 |
| profile / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.83 → 0.52 |
| profile / warm | league_change_hints | 1.00 → 1.00 | 0.34 → 0.27 |
| profile / warm | view_profile | 1.00 → 1.00 | 0.80 → 0.85 |
| notifications / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.11 → 0.50 |
| notifications / cold | league_change_hints | 1.00 → 1.00 | 0.40 → 0.43 |
| notifications / cold | view_profile | 1.00 → 1.00 | 0.86 → 0.82 |
| notifications / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.72 → 0.64 |
| notifications / warm | league_change_hints | 1.00 → 1.00 | 0.34 → 0.26 |
| notifications / warm | view_profile | 1.00 → 1.00 | 0.90 → 0.83 |
| commissioner-settings / cold | league_members,leagues,drafts,league_seasons | 2.00 → 2.00 | 0.87 → 0.53 |
| commissioner-settings / cold | league_change_hints | 1.00 → 1.00 | 0.52 → 0.38 |
| commissioner-settings / cold | league_members,profiles | 1.00 → 1.00 | 0.66 → 0.45 |
| commissioner-settings / cold | league_seasons | 1.00 → 1.00 | 0.35 → 0.20 |
| commissioner-settings / cold | lineup_slot_templates | 1.00 → 1.00 | 0.24 → 0.27 |
| commissioner-settings / cold | leagues | 1.00 → 1.00 | 0.17 → 0.16 |
| commissioner-settings / cold | season_weeks | 1.00 → 1.00 | 0.04 → 0.04 |
| commissioner-settings / warm | league_members,leagues,drafts,league_seasons | 2.00 → 2.00 | 0.79 → 1.01 |
| commissioner-settings / warm | league_change_hints | 1.00 → 1.00 | 0.30 → 0.25 |
| commissioner-settings / warm | league_members,profiles | 1.00 → 1.00 | 1.06 → 0.57 |
| commissioner-settings / warm | league_seasons | 1.00 → 1.00 | 0.27 → 0.23 |
| commissioner-settings / warm | lineup_slot_templates | 1.00 → 1.00 | 0.43 → 0.35 |
| commissioner-settings / warm | leagues | 1.00 → 1.00 | 0.17 → 0.14 |
| commissioner-settings / warm | season_weeks | 1.00 → 1.00 | 0.04 → 0.04 |
| team-roster / cold | view_roster | 1.00 → 1.00 | 3.26 → 7.39 |
| team-roster / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.77 → 0.46 |
| team-roster / cold | league_change_hints | 1.00 → 1.00 | 0.43 → 0.25 |
| team-roster / cold | get_league_version | 1.00 → 1.00 | 0.42 → 0.77 |
| team-roster / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.98 → 0.45 |
| team-roster / warm | league_change_hints | 1.00 → 1.00 | 0.42 → 0.32 |
| team-roster / warm | get_league_version | 1.00 → 1.00 | 0.50 → 0.53 |
| claim-player / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.07 → 0.42 |
| claim-player / cold | view_claim_editor | 1.00 → 1.00 | 32.26 → 33.74 |
| claim-player / cold | league_change_hints | 1.00 → 1.00 | 0.34 → 0.30 |
| claim-player / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.98 → 0.55 |
| claim-player / warm | league_change_hints | 1.00 → 1.00 | 0.46 → 0.44 |
| claim-player / warm | get_league_version | 1.00 → 1.00 | 0.56 → 0.42 |
| timeline / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.92 → 0.46 |
| timeline / cold | league_change_hints | 1.00 → 1.00 | 0.28 → 0.27 |
| timeline / cold | view_team_timeline | 1.00 → 1.00 | 4.65 → 1.46 |
| timeline / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.81 → 0.50 |
| timeline / warm | league_change_hints | 1.00 → 1.00 | 0.27 → 0.29 |
| timeline / warm | view_team_timeline | 1.00 → 1.00 | 3.98 → 1.44 |
| dynasty / cold | get_dynasty_forecast_inputs | 1.00 → 1.00 | 95.44 → 89.41 |
| dynasty / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.76 → 0.45 |
| dynasty / cold | league_change_hints | 1.00 → 1.00 | 0.34 → 0.30 |
| dynasty / cold | league_members,profiles | 1.00 → 1.00 | 0.91 → 0.36 |
| dynasty / cold | league_seasons | 1.00 → 1.00 | 0.46 → 0.14 |
| dynasty / cold | players | 6.00 → 6.00 | 0.17 → 0.19 |
| dynasty / cold | dynasty_rankings | 1.00 → 1.00 | 0.11 → 0.05 |
| dynasty / warm | get_dynasty_forecast_inputs | 1.00 → 1.00 | 92.54 → 81.68 |
| dynasty / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.76 → 0.70 |
| dynasty / warm | league_change_hints | 1.00 → 1.00 | 0.33 → 0.24 |
| dynasty / warm | league_members,profiles | 1.00 → 1.00 | 0.53 → 0.40 |
| dynasty / warm | league_seasons | 1.00 → 1.00 | 0.24 → 0.19 |
| dynasty / warm | players | 6.00 → 6.00 | 0.15 → 0.15 |
| dynasty / warm | dynasty_rankings | 1.00 → 1.00 | 0.13 → 0.05 |
| draft-launcher / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.77 → 0.43 |
| draft-launcher / cold | league_change_hints | 1.00 → 1.00 | 0.34 → 0.30 |
| draft-launcher / cold | view_draft_room | 1.00 → 1.00 | 7.20 → 6.35 |
| draft-launcher / cold | get_league_version | 1.00 → 1.00 | 0.47 → 0.49 |
| draft-launcher / cold | players | 2.00 → 2.00 | 0.08 → 0.10 |
| draft-launcher / cold | drafts | 1.00 → 1.00 | 0.22 → 0.18 |
| draft-launcher / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.17 → 1.67 |
| draft-launcher / warm | league_change_hints | 1.00 → 1.00 | 0.34 → 0.26 |
| draft-launcher / warm | get_league_version | 1.00 → 1.00 | 0.49 → 0.40 |
| draft-launcher / warm | players | 2.00 → 2.00 | 0.10 → 0.06 |
| draft-launcher / warm | drafts | 1.00 → 1.00 | 0.36 → 0.25 |
| auction-room / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.03 → 0.43 |
| auction-room / cold | league_change_hints | 1.00 → 1.00 | 0.33 → 0.33 |
| auction-room / cold | view_draft_room | 1.00 → 1.00 | 5.81 → 6.34 |
| auction-room / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.83 → 0.46 |
| auction-room / warm | league_change_hints | 1.00 → 1.00 | 0.42 → 0.29 |
| auction-room / warm | get_league_version | 1.00 → 1.00 | 0.50 → 0.41 |
| rookie-room / cold | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 0.69 → 0.54 |
| rookie-room / cold | league_change_hints | 1.00 → 1.00 | 0.31 → 0.27 |
| rookie-room / cold | view_draft_room | 1.00 → 1.00 | 5.76 → 6.18 |
| rookie-room / cold | players | 2.00 → 2.00 | 0.05 → 0.08 |
| rookie-room / warm | league_members,leagues,drafts,league_seasons | 1.00 → 1.00 | 1.06 → 0.77 |
| rookie-room / warm | league_change_hints | 1.00 → 1.00 | 0.39 → 0.44 |
| rookie-room / warm | get_league_version | 1.00 → 1.00 | 0.64 → 0.40 |
| rookie-room / warm | players | 2.00 → 2.00 | 0.12 → 0.08 |
| home-day-0 / action | view_home | 1.00 → 1.00 | 12.75 → 8.57 |
| home-day-0 / action | nba_games | 1.00 → 1.00 | 0.05 → 0.04 |
| home-day-1 / action | view_home | 1.00 → 1.00 | 8.79 → 7.07 |
| home-day-1 / action | nba_games | 1.00 → 1.00 | 0.04 → 0.03 |
| home-day-2 / action | view_home | 1.00 → 1.00 | 10.24 → 8.13 |
| home-day-2 / action | nba_games | 1.00 → 1.00 | 0.07 → 0.05 |
| home-day-3 / action | view_home | 1.00 → 1.00 | 8.23 → 7.16 |
| home-day-3 / action | get_league_version | 1.00 → 1.00 | 0.61 → 0.37 |
| home-day-3 / action | nba_games | 1.00 → 1.00 | 0.02 → 0.02 |
| home-day-4 / action | view_home | 1.00 → 1.00 | 8.44 → 6.93 |
| home-day-4 / action | nba_games | 1.00 → 1.00 | 0.05 → 0.04 |
| home-day-5 / action | view_home | 1.00 → 1.00 | 9.01 → 8.92 |
| home-day-5 / action | nba_games | 1.00 → 1.00 | 0.04 → 0.06 |
| home-day-6 / action | view_home | 1.00 → 1.00 | 7.28 → 7.15 |
| home-day-6 / action | nba_games | 1.00 → 1.00 | 0.03 → 0.03 |
| home-previous / action | view_home | 1.00 → 1.00 | 8.28 → 6.78 |
| home-previous / action | view_lineup | 2.00 → 2.00 | 3.08 → 2.60 |
| home-previous / action | view_standings | 1.00 → 1.00 | 0.63 → 0.51 |
| home-previous / action | get_matchup_forecast | 1.00 → 1.00 | 0.48 → 0.49 |
| home-previous / action | matchups | 1.00 → 1.00 | 0.30 → 0.23 |
| home-previous / action | nba_games | 1.00 → 1.00 | 0.03 → 0.03 |
| matchup-day-0 / action | view_home | 1.00 → 1.00 | 9.81 → 7.26 |
| matchup-day-0 / action | view_lineup | 2.00 → 2.00 | 3.42 → 2.65 |
| matchup-day-0 / action | view_standings | 1.00 → 1.00 | 0.69 → 0.50 |
| matchup-day-0 / action | get_matchup_forecast | 1.00 → 1.00 | 0.42 → 0.44 |
| matchup-day-0 / action | matchups | 1.00 → 1.00 | 0.26 → 0.17 |
| matchup-day-0 / action | nba_games | 1.00 → 1.00 | 0.04 → 0.03 |
| matchup-day-1 / action | view_home | 1.00 → 1.00 | 7.11 → 7.33 |
| matchup-day-1 / action | view_lineup | 2.00 → 2.00 | 3.00 → 2.65 |
| matchup-day-1 / action | view_standings | 1.00 → 1.00 | 0.71 → 0.60 |
| matchup-day-1 / action | get_matchup_forecast | 1.00 → 1.00 | 0.31 → 0.31 |
| matchup-day-1 / action | matchups | 1.00 → 1.00 | 0.18 → 0.24 |
| matchup-day-1 / action | nba_games | 1.00 → 1.00 | 0.03 → 0.02 |
| matchup-day-2 / action | view_home | 1.00 → 1.00 | 10.29 → 7.55 |
| matchup-day-2 / action | view_lineup | 2.00 → 2.00 | 3.76 → 3.01 |
| matchup-day-2 / action | view_standings | 1.00 → 1.00 | 0.81 → 0.64 |
| matchup-day-2 / action | get_matchup_forecast | 1.00 → 1.00 | 0.44 → 0.46 |
| matchup-day-2 / action | matchups | 1.00 → 1.00 | 0.22 → 0.24 |
| matchup-day-2 / action | nba_games | 1.00 → 1.00 | 0.05 → 0.04 |
| matchup-day-4 / action | view_home | 1.00 → 1.00 | 8.65 → 6.95 |
| matchup-day-4 / action | view_lineup | 2.00 → 2.00 | 3.12 → 2.59 |
| matchup-day-4 / action | view_standings | 1.00 → 1.00 | 0.68 → 0.54 |
| matchup-day-4 / action | get_matchup_forecast | 1.00 → 1.00 | 0.61 → 0.30 |
| matchup-day-4 / action | matchups | 1.00 → 1.00 | 0.18 → 0.18 |
| matchup-day-4 / action | nba_games | 1.00 → 1.00 | 0.04 → 0.03 |
| matchup-day-5 / action | view_home | 1.00 → 1.00 | 9.00 → 6.66 |
| matchup-day-5 / action | view_lineup | 2.00 → 2.00 | 3.17 → 2.52 |
| matchup-day-5 / action | view_standings | 1.00 → 1.00 | 0.65 → 0.54 |
| matchup-day-5 / action | get_matchup_forecast | 1.00 → 1.00 | 0.28 → 0.11 |
| matchup-day-5 / action | matchups | 1.00 → 1.00 | 0.21 → 0.22 |
| matchup-day-5 / action | nba_games | 1.00 → 1.00 | 0.03 → 0.02 |
| matchup-day-6 / action | view_home | 1.00 → 1.00 | 7.24 → 6.72 |
| matchup-day-6 / action | view_lineup | 2.00 → 2.00 | 2.78 → 2.56 |
| matchup-day-6 / action | view_standings | 1.00 → 1.00 | 0.52 → 0.46 |
| matchup-day-6 / action | get_matchup_forecast | 1.00 → 1.00 | 0.10 → 0.18 |
| matchup-day-6 / action | matchups | 1.00 → 1.00 | 0.22 → 0.30 |
| matchup-day-6 / action | nba_games | 1.00 → 1.00 | 0.02 → 0.02 |
| edit-lineup / action | view_lineup | 1.00 → 1.00 | 3.08 → 2.85 |
| edit-lineup / action | players | 1.00 → 1.00 | 0.06 → 0.06 |
| players-search / action | view_players | 1.00 → 1.00 | 12.99 → 15.27 |
| players-scroll / action | view_players | 1.00 → 1.00 | 19.34 → 22.15 |
| players-filter-availability / action | view_players | 1.00 → 1.00 | 19.99 → 13.33 |
| players-filter-position / action | view_players | 1.00 → 1.00 | 17.42 → 13.10 |
| players-filter-health / action | view_players | 1.00 → 1.00 | 21.25 → 13.52 |
| players-filter-game-today / action | view_players | 1.00 → 1.00 | 13.16 → 18.71 |
| players-filter-experience / action | view_players | 1.00 → 1.00 | 7.77 → 8.76 |
| compose-select / action | view_roster | 2.67 → 2.33 | 4.75 → 4.42 |
| compose-select / action | preview_trade_legality | 1.00 → 1.00 | 20.34 → 23.58 |
| compose-select / action | get_trade_estimate_inputs | 1.00 → 1.00 | 15.60 → 16.30 |
| compose-select / action | get_league_version | 2.00 → 2.00 | 0.08 → 0.09 |
| compose-select / action | save_trade_estimate_quote | 1.00 → 1.00 | 1.27 → 0.94 |
| compose-select / action | league_members | 1.00 → 1.00 | 0.01 → 0.01 |
| compose-request / action | preview_trade_legality | 1.00 → 1.00 | 22.96 → 23.76 |
| compose-request / action | get_trade_estimate_inputs | 1.00 → 1.00 | 15.57 → 15.94 |
| compose-request / action | get_league_version | 2.00 → 2.00 | 0.08 → 0.18 |
| compose-request / action | save_trade_estimate_quote | 1.00 → 1.00 | 1.24 → 1.04 |
| compose-request / action | league_members | 1.00 → 1.00 | 0.01 → 0.01 |
| compose-review / action | players | 1.00 → 1.00 | 0.03 → 0.03 |
| player-game-log / action | view_player | 1.00 → 1.00 | 1.35 → 1.13 |
| player-news / action | view_player | 1.00 → 1.00 | 0.85 → 0.77 |
| player-league-history / action | view_player | 1.00 → 1.00 | 0.84 → 1.03 |
| home / warm | view_home | 1.00 → 0.00 | 8.53 → — |
| home / warm | get_league_version | 1.00 → 0.00 | 0.92 → — |
| home / warm | nba_games | 1.00 → 0.00 | 0.02 → — |
| matchup / warm | get_league_version | 1.00 → 0.00 | 0.33 → — |
| lineup / cold | get_league_version | 1.00 → 0.00 | 0.38 → — |
| roster / warm | get_league_version | 1.00 → 0.00 | 0.09 → — |
| moves / warm | get_league_version | 1.00 → 0.00 | 0.07 → — |
| players / warm | get_league_version | 1.00 → 0.00 | 0.18 → — |
| player / warm | get_league_version | 1.00 → 0.00 | 0.25 → — |
| trades / warm | get_league_version | 1.00 → 0.00 | 0.10 → — |
| compose / warm | view_roster | 1.00 → 0.00 | 6.49 → — |
| league / warm | get_league_version | 1.00 → 0.00 | 0.07 → — |
| standings / warm | get_league_version | 1.00 → 0.00 | 0.08 → — |
| activity / warm | get_league_version | 1.00 → 0.00 | 0.08 → — |
| picks / warm | get_league_version | 1.00 → 0.00 | 0.07 → — |
| schedule / warm | get_league_version | 1.00 → 0.00 | 0.07 → — |
| draft / warm | get_league_version | 1.00 → 0.00 | 0.06 → — |
| claim-player / cold | get_league_version | 1.00 → 0.00 | 0.08 → — |
| auction-room / cold | get_league_version | 1.00 → 0.00 | 0.07 → — |
| rookie-room / cold | get_league_version | 1.00 → 0.00 | 0.07 → — |
| matchup-day-3 / action | get_league_version | 1.00 → 0.00 | 0.10 → — |
| matchup-previous / action | get_league_version | 1.00 → 0.00 | 0.10 → — |
| matchup-next / action | get_league_version | 1.00 → 0.00 | 0.09 → — |
| edit-lineup / action | get_league_version | 1.00 → 0.00 | 0.09 → — |
| players-scroll / action | get_league_version | 1.00 → 0.00 | 0.07 → — |

## Idle minutes

Each build has ten quiet idle minutes on Home and ten on Matchup. Home made one performance-beacon request in each capture. Matchup made none. No idle version checks were observed before or after. The production polling burst was not reproduced here, so no idle polling gain is claimed.

| Screen | Minute | Requests before → after | Raw B before → after | Compressed B before → after | DB ms before → after |
|---|---:|---:|---:|---:|---:|
| idle-home | 1 | 1.00 → 1.00 | 11.00 → 11.00 | 15.00 → 15.00 | 1.84 → 1.92 |
| idle-home | 2 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 4 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 5 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 6 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 7 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 8 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 9 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-home | 10 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 1 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 2 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 3 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 4 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 5 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 6 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 7 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 8 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 9 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |
| idle-matchup | 10 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 | 0.00 → 0.00 |

## Initial cleanup

The private stack stopped successfully. Its cleanup receipt records `stage: stopped`, `cleanup: true`, and no errors. Docker lists no containers, volumes, or networks for `pt4bafablerq`. No listeners remain in the reserved `633xx` port block. Copied dump files and the mini backup directory are absent. The source backup was retained.

The initial accepted evidence has six full walks with 558 states, six isolated Players walks with 60 states, one previous-client walk with ten states, twelve response contracts, and forty idle minutes. Physical phones and the Broadcast transport were not exercised. Final submissions and notification delivery were not triggered.

## Game-night recovery follow-up

The October 30 stale-score report prompted a separate recovery trial. The baseline keeps all changes through `1f36ed77`. Both clients use the same private database and server. This follow-up changes no SQL or transport code. Release 2.9.1 phones see the same server contract. The client keeps the existing HTTP version fallback for old servers.

The private bench restores the same production-shaped backup and seeds a synthetic live matchup. Its restore helper splits large INSERT statements into batches of 1,000 rows. A hash of the ordered row text verifies that batching preserves the dump's data. The source backup is untouched. No production requests, notifications, or external image requests are allowed in the recovery browser.

Chromium uses a separate agent-browser session at 390 × 844. Mobile WebKit uses the iPhone 13 profile at the same width. A WebSocket proxy forwards real joins and heartbeat replies while dropping selected data frames. The score and stat trials drop the version packet. The silent-data trial leaves the socket open and its heartbeats healthy. Other trials drop all frames, restart only this project's realtime container while withholding the close event, disconnect the automation context, hide and show the page, and suspend and resume the automation browser. Chromium suspends only the isolated automation browser and its descendant processes. WebKit pauses the isolated page clock, then releases overdue timers on resume. A JavaScript tick counter checks each pause. The shared mini never sleeps. Chromium page lifecycle freeze was rejected because its timer still ran; that wake result is excluded. Separate before/after sleep pairs replace the initial sleep rows. Stopping the WebKit launcher group or its descendants was also rejected because XPC page processes continued running. Those processes were not signalled. Physical sleep and physical phones remain unverified.

The client now checks the HTTP version every 20 seconds during live games, even with connected realtime. An unchanged version reuses the cached view. A score, stat, player_stats, or game hint invalidates the relevant Home views, which also supply Matchup. A 200 ms coalescer combines related hints into one read. The returned view's version is saved so the next fallback does not reread the same data. Players remains unaffected by score changes.

Hidden or offline pages stop the guard. Visibility, focus, pageshow, and online events check the version immediately. Reopening a cached matchup also validates its version. Connected cache authority expires after 30 seconds without a hint or successful HTTP proof. A final or empty slate has no recurring guard. Upcoming games schedule a check at tipoff. A historical selected day watches today's small game-status result when today's slate has games.

Before the fix, 12 recovery assertions failed and three passed in the initial focused reproduction. Two cache assertions also failed before the cache changes. The final focused checks cover live recovery, unchanged live idle, final idle, hint coalescing, hidden and offline recovery, historical dates, inactive cache aliases, and ordinary screen cache behavior. The full suite from the initial traffic trial is historical evidence. Per the latest test instruction, the follow-up runs only affected tests; the next full suite is due before a push. No push is authorized here.

Recovery artifact: `aeae832c`. Baseline artifact: `5adc07b7`, whose application files match `1f36ed77`. Three rounds alternate before and after in each engine. The table gives median elapsed seconds and the candidate range. The timer starts at the database hint timestamp. A timeout is a lower bound, not a recovery time.

| Profile | Signal or fault | Before seconds | After seconds, median [range] | After successes |
|---|---|---:|---:|---:|
| Chromium | version | 0.350 | 0.480 [0.414–0.647] | 3/3 |
| Chromium | score, version dropped | >2, no refresh | 0.353 [0.322–0.798] | 3/3 |
| Chromium | stat, version dropped | >2, no refresh | 0.391 [0.367–0.611] | 3/3 |
| Chromium | score + stat + version | 0.208 | 0.700 [0.329–0.791] | 3/3 |
| Chromium | data dropped, heartbeat healthy | >45, no refresh | 19.226 [19.009–19.298] | 3/3 |
| Mobile WebKit | version | 0.376 | 0.411 [0.381–0.415] | 3/3 |
| Mobile WebKit | score, version dropped | >2, no refresh | 0.490 [0.452–0.664] | 3/3 |
| Mobile WebKit | stat, version dropped | >2, no refresh | 0.505 [0.420–0.726] | 3/3 |
| Mobile WebKit | score + stat + version | 0.448 | 0.498 [0.420–0.620] | 3/3 |
| Mobile WebKit | data dropped, heartbeat healthy | >45, no refresh | 19.355 [19.184–19.376] | 3/3 |

Every delivered hint trial makes one view read and no version lookup within its post-publication measurement window. A combined burst also makes one view read. Every silent-data recovery makes one version lookup and one view read. The baseline makes neither request during its 45-second stale window. The guard's first deadline is relative to screen load, about one second before the injected change. All 24 candidate hint trials finish within 0.798 seconds. The coalescer deliberately adds a short delay; no improvement in already-working version-hint latency is claimed.

The ten initial screenshot pairs in these rounds have identical pixels. Chromium screenshots come from agent-browser. WebKit screenshots use the isolated mobile automation context. The score changes only after a published update.

The original Players response reduction is unchanged. The recovery guard intentionally adds low-rate live version traffic and validation on return. The original walk totals above were not remeasured for this artifact and are not presented as its totals.

Focused validation: 319 app and cache tests passed across 32 files after the last product change. The two backup-helper tests also passed. `npm run lint:all`, `npm run typecheck`, `npm run typecheck:tests`, and `npm run check:dead-code` passed. New bench entry points are registered in `knip.json`.

To repeat this trial on the reserved private mini:

1. Restore the copied backup with `node tests/e2e/l5c-recovery-backup.mjs` before running `node tests/e2e/l5c-stack.mjs`. Start at `5adc07b7` and save `web-export/` as `recovery-before-export/`.
2. Check out `aeae832c`. Build with `buildWeb` and the same local keys and ready origin. Save `web-export/` as `recovery-after-export/`. Then check out `5acbb3c4` for the corrected bench without rebuilding the app.
3. Run `node tests/e2e/l5c-recovery-series.mjs`. It alternates three core pairs per engine, then one fault pair and one idle pair per engine. An optional numeric argument resumes at a capture index. Failed attempts are retained with a suffix.
4. Individual groups use `node tests/e2e/l5c-recovery.mjs after webkit 1 faults`. Serve the matching export first. The script verifies its release provenance. `pilot`, `core`, `hints`, `faults`, `idle`, and individual case names are supported.
5. Touch the lane's `stop` marker after the browser checks. Verify the cleanup receipt and absence of this project's containers, volumes, networks, backup copies, and reserved-port listeners.

Each remaining fault has one accepted before/after pair per profile. Network, visibility, and sleep times start when access resumes. Other times start at hint publication. Publication follows completion of the container restart; restart shutdown and startup time is outside that recovery interval.

| Profile | Fault | Before seconds | After seconds | After version / view reads |
|---|---|---:|---:|---:|
| Chromium | all realtime frames dropped | >45, no refresh | 19.038 | 1 / 1 |
| Chromium | realtime restarted, close withheld | >45, no refresh | 16.789 | 1 / 1 |
| Chromium | network offline then online | >5, no refresh | 0.287 | 1 / 1 |
| Chromium | hidden 25 seconds then visible | >5, no refresh | 0.241 | 2 / 1 |
| Chromium | browser processes paused 25 seconds | >5, no refresh | 0.128 | 1 / 1 |
| Mobile WebKit | all realtime frames dropped | >45, no refresh | 19.199 | 1 / 1 |
| Mobile WebKit | realtime restarted, close withheld | >45, no refresh | 16.908 | 1 / 1 |
| Mobile WebKit | network offline then online | >5, no refresh | 0.313 | 1 / 1 |
| Mobile WebKit | hidden 25 seconds then visible | >5, no refresh | 0.288 | 2 / 1 |
| Mobile WebKit | page clock paused 25 seconds | >5, no refresh | 0.146 | 1 / 1 |

No measured API response occurred while either profile was hidden, offline, or paused. Both replacement sleep pairs passed their tick-counter proof. Chromium paused eleven processes belonging to its own automation browser. WebKit released no timer ticks during its page-clock pause and delivered one overdue tick on resume. These are browser simulations, not physical device sleep tests.

Returning from a hidden page makes two sequential version lookups and one view read. The resume guard and route activation each validate. Concurrent lookups are shared. An extra view is not fetched. This cost is reported rather than counted as an idle traffic saving.

The restart initially invalidated one Chromium capture because the next case started before a subscription joined. The harness now waits for both a real join and the baseline read. Initial sleep rows in all fault-group reports are excluded. New `before/after-{engine}-1-sleep` reports replace them. The non-sleep WebKit rows come from its last attempt. Failed suspension proofs and earlier attempts remain in the lane folder.

An earlier all-frame Chromium trial recovered in 21.438 seconds. A later subscription-setup failure invalidated that capture. This remains the worst observed live fallback recovery and is also below 30 seconds. It is not included in the paired table.

## Recovery idle cost and final checks

Each idle window lasts about 60.1–60.3 seconds. The table counts HTTP version lookups and Home view reads. Setup, auth, beacons, and WebSocket heartbeat frames are outside these counts. The slate is explicitly live or final. This is separate from the initial traffic trial's longer quiet captures.

| Profile | Slate | Version lookups per minute, before → after | View reads per minute, before → after |
|---|---|---:|---:|
| Chromium | live | 0 → 3 | 0 → 0 |
| Chromium | final | 0 → 0 | 0 → 0 |
| Mobile WebKit | live | 0 → 3 | 0 → 0 |
| Mobile WebKit | final | 0 → 0 | 0 → 0 |

The follow-up has 92 accepted windows: 60 core hint and silent-data windows, 20 other fault windows, four replacement sleep windows, and eight idle minutes. All 42 candidate recovery windows pass their deadlines. All four candidate idle windows have the expected rates. All 26 initial screenshot pairs have identical pixels. The original production trigger remains unproven; both a silently stale connection and ignored raw hints were reproduced privately.

`recovery-summary.json` records the accepted rows, explicit sleep exclusions, counters, recovery ranges, build provenance, and pixel comparisons. Raw reports and screenshots are under `recovery/`. The last bench source is `5acbb3c4`. The application artifact remains `aeae832c`; later source commits only correct the bench and report. The idle series resumed at capture 16 after the failed sleep proof. Separate `sleep` captures for both labels and engines replace the original sleep rows.

The full suite was not repeated for this follow-up. Run it once before a future push. No push, PR, deployment, production request, email, or push notification was made.


The follow-up stack stopped at 03:19 UTC. `recovery-cleanup.json` records `stage: stopped`, `cleanup: true`, no cleanup errors, and zero project containers, volumes, networks, or reserved-port listeners. Copied backups are absent. The original local schema and data dumps remain intact. The automation browsers and the scoped WebKit proxy are closed.
