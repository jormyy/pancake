# Review — `task/t_a4dc0293-hardening`, round 6

**Approve.** Nothing gating survived. This range adds evidence and a diagnostic probe for the missing paint entry. It changes no product code. The probe is broken in two ways, and both need a fix before its next run.

Reviewed `1a98fc2..c8945c4`: 6 commits, 35 files, +6,350/−4. The range touches only `tests/`, `docs/evidence/`, `WORKLOG.md` and one `package.json` script. There were four hunt dimensions: probe measurement (the crown jewel), session ownership and lifecycle, evidence and WORKLOG honesty, and one unsteered cross-cutting sweep. An agent that did not raise a candidate tried to refute it.

**38 raised / 12 refuted / 26 survived (0 blocker, 0 material, 8 minor, 18 nit).** None gates.

**The probe cannot run on a real browser (item 1). If that is fixed, its early paint reader still records nothing and reports that it worked (item 2).** Both fail loud or mislabel failures. Neither can make a launch pass. The probe does not ship and gates nothing, so neither gates the merge. But the next probe run will measure nothing unless both are fixed.

## Round-5 scorecard

This range made no code change. `git diff --stat 1a98fc2..c8945c4 -- app lib core hooks components supabase scripts .github` is empty. All ten round-5 items are carried unchanged:

| Round-5 item | Status |
| --- | --- |
| 1 — backoff does not stop per-minute failures (pre-merge ask) | Unchanged |
| 2 — hook test cannot fail on league-switch clears (pre-merge ask) | Unchanged |
| 3 — live-poll handler wiring untested (pre-merge ask) | Unchanged |
| 4 — weekly gate comment overclaims (pre-merge ask) | Unchanged |
| 5–10 — post-merge trackers | Unchanged |

The WORKLOG says the same: "none of its residuals were changed in this phase" (`WORKLOG.md:452`).

## Gating

None.

## Pre-merge asks (not gating)

### 1. The probe cannot parse real `eval` output · minor · pre-merge ask · [VERIFIED]

`tests/e2e/pwa-paint-probe.mjs:70-74`, used by the sign-in poll and the paint read (`:288`).

```js
const start = output.indexOf('{')
...
return JSON.parse(output.slice(start, output.lastIndexOf('}') + 1))
```

**agent-browser 0.25.4 prints an eval result as a JSON string literal, so this parser always throws.** I ran it:

```
RAW: "{\"path\":\"text/html,<p>hi</p>\",\"n\":1}"
probe THROWS Expected property name or '}' in JSON at position 1 (line 1 column 2)
gate OK { path: 'text/html,<p>hi</p>', n: 1 }
```

- Every launch becomes a "probe error", so the next 20-launch run measures 0 of 20 again. That is the same outcome as run 1.
- The gate's parser (`browser-pwa-launch.mjs:31-35`) and 12 other `tests/e2e` files parse twice when the value is a string. The probe dropped that step.
- The unit tests cannot see it. Their fake returns raw JSON (`tests/e2e-pwa-paint-probe-entry.test.ts:14`, `:29`).
- **Why not gating:** it fails loud (exit 1) and never passes a launch. The probe is test-only, and no gate or CI job runs it.
- **Fix:** move the double parse into a shared helper, or copy it. No module exports one, and importing the gate's module runs `createBrowser` at import (`browser-pwa-launch.mjs:28`). Make the fake return `JSON.stringify(JSON.stringify(state))`.

### 2. The early paint reader is dropped before the page loads, and the report says it was installed · minor · pre-merge ask · [VERIFIED]

`tests/e2e/pwa-paint-probe.mjs:150-153`. The misfiling follows at `:307-311`, and `tests/e2e/README.md:106` repeats the claim.

```js
const result = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY_OBSERVER_SCRIPT }, sessionId)
return { installed: true, identifier: result.identifier ?? null, endpointHost: new URL(endpoint).hostname }
} finally {
  client.close()
```

**The script belongs to the CDP session that added it, and closing the socket drops it before the measured `open`.**

- Two agents reproduced this separately on real Chromium through agent-browser 0.25.4. With the client closed, `paintEarly` was `null` after the next `open`. With the client kept open, the observer recorded first-paint and first-contentful-paint. The page target ID was the same both times, so detaching is the cause.
- The season-3 failure produces this state: installed, `paintEarly` null, and no FCP from either late reader. That launch gets the reason "no early observer", which contradicts `installed: true`. It lands in none of the summary buckets: `noLateReaderEvidence` needs `!installed`, and `missingEverywhereWithEarly` needs `paintEarly`. The headline still says "Early observer installed on N launches".
- The test fakes the CDP client with a `close()` that does nothing (`tests/e2e-pwa-paint-probe-entry.test.ts:79-100`).
- Item 1 hides this defect today. Fixing item 1 exposes it on every launch.
- **Fix:** keep the client open until after the paint read, then remove the script and close it. Record the observer as running only when `paintEarly !== null`. Derive each summary bucket from `judgeLaunch`'s reason so every failure lands in exactly one bucket, and test that.

### 3. The gate status blames the host as fact · minor · pre-merge ask

`WORKLOG.md:470-474` and `:480-483`.

> which is a host/browser-engine condition this branch neither introduced nor can fix

> `relaunch.png` shows the app … — the paint happened; the engine did not report a `first-contentful-paint` entry

- "Not introduced" has support: phase 5 recorded baseline `main` losing the entry on the same host, and the same build both passed and failed.
- "Engine condition" and "nor can fix" do not. Iteration 14's decision rule concedes that an eviction or buffering cause cannot be excluded, and it plans a measurement-only repair (`WORKLOG.md:498-500`). `relaunch.png` is not kept in the repo.
- Later iterations never restate the gate paragraph, so this is still the latest gate status.
- **Why not gating:** the gate stays red and unfinished, and no decision rests on who is at fault.
- **Fix:** change the clause to "seen on main too; cause unknown (engine or late-reader measurement); probe pending". Keep the screenshot, or drop the citation.

### 4. The probe measures a different launch from the gate it diagnoses · minor · pre-merge ask

`tests/e2e/pwa-paint-probe.mjs:277-287` against `tests/e2e/browser-pwa-launch.mjs:139-142` and `:157-160`.

- The gate first does a signed-out launch of `/`, clears `localStorage` and relaunches. After sign-in it waits 2,000 ms, then opens `/roster`.
- The probe signs in and opens `/roster` at once.
- Neither the header nor the README states the difference. So a clean probe run cannot clear the gate's condition.
- **Fix:** copy the gate's sequence, or state the difference in the report header and the README.

### 5. Failed setup records zero attempts · minor · pre-merge ask

`tests/e2e/pwa-paint-probe.mjs:162-174`, `:273`, `:279`.

- `openSetupPage` throws without its count, and the record starts at 0. Run 1's report shows "0" next to "setup navigation failed after 3 attempts" (`local-phase8/pwa-paint-probe-run1-report.md`).
- So the claim "its attempts are recorded per launch" (`WORKLOG.md:509`, `tests/e2e/README.md:109-110`) is false when setup fails.
- **Fix:** attach the count to the thrown error and copy it into the record.

### 6. The test's fake browser cannot fail a close · minor · pre-merge ask (optional)

`tests/e2e-pwa-paint-probe-entry.test.ts:24-27` against `tests/e2e/browser-agent.mjs:258`.

- The fake releases ownership before the command runs, and its dispose does nothing. Real `createBrowser` releases only after a close succeeds.
- If a probe-owned close fails twice, the owner's dispose throws (`scenario-resource-owner.mjs:47-56`), and `runPaintProbeEntry` rejects after the reports are on disk. That was reasoned from code, not executed.
- The header comment (`:8-12`) says the fake makes "the same calls createBrowser makes". The calls match, but the order does not.
- **Fix:** release only after a successful close, give the fake a real dispose, and add one test where a close fails.

### 7. The new tests do not prove the commit's claims · minor · pre-merge ask · [VERIFIED]

`tests/e2e-pwa-paint-probe-entry.test.ts:52-58`, against `tests/e2e/pwa-paint-probe.mjs:219`, `:271`, `:277`, `:283`, `:286`, `:294-296`.

A refuter ran each mutation against both new test files at HEAD, where the baseline is 9 of 9 passing. These mutations still pass:

| Mutation | Why no test fails |
| --- | --- |
| The measured `open` retries (`:286`) | The fake `open` never fails, so no retry fires |
| Fresh sessions close only when their launch passes (`:294-296`) | The only failing-launch test does not check closes |
| `early === false` returns PASS (`:219`) | No fixture sets `paintEarly.entries`. **This mutation changes the gate itself.** |
| The early observer is hardcoded to "not installed" (`:283`) | The fake has no CDP endpoint, and no test checks that the probe asks for one |
| The reused session signs in on every launch (`:277`) | Every entry test uses `signedOut: true` |
| All fresh sessions share one name (`:271`) | The sorted close list looks the same |

- **The claims in `c8945c4` go beyond what the tests prove.** "One measured navigation per launch, no retries" and "closes exactly its own sessions" are true in the code, but no test would catch a regression.
- "Missing = FAIL" is tested only when no early observer ran.
- **Fix:** let the fake fail `open` and `close` on demand. Add one signed-in entry test. Add `judgeLaunch` cases with `paintEarly.entries` empty and with an FCP entry, and assert both FAIL.

## Post-merge tracker

8. **Started by some paths, the probe does nothing and exits 0** · minor. `tests/e2e/pwa-paint-probe.mjs:343` compares `import.meta.url` with `file://${process.argv[1]}`. Started through the `/tmp` symlink or a path with a space, main never runs. This was reproduced with the same guard line. The idiom is in 27 `tests/e2e` files at `1a98fc2`, so it is pre-existing and the probe copied it. No PASS line or report is written, and the documented `npm run` path works. **Fix:** one sweep to `pathToFileURL(process.argv[1]).href`, as `tests/e2e/local-secret-scan.mjs:126` does.
9. **Some failures count twice or get the wrong label** · nit. `pwa-paint-probe.mjs:219`, `:308`, `:310`. When both the early and late readers see FCP, the launch counts in two buckets. `early === false` is checked before `observed`. This only becomes reachable after item 2 is fixed.
10. **`judgeLaunch` ignores the early observer's own error** · nit. `store.error` is set at `:86` and ignored at `:215-219`.
11. **"The page's CDP endpoint" is the browser endpoint** · nit. `pwa-paint-probe.mjs:25`, `tests/e2e/README.md:104`. `get cdp-url` returned `ws://…/devtools/browser/…`.
12. **The header comment is stale** · nit. `pwa-paint-probe.mjs:17-22` says "every session closed first", "two independent readers" and "nothing is … retried". The probe closes only its own sessions, has three readers, and retries sign-in setup.
13. **The mid-life migration override is not in the soak records** · nit. The report says the check was off (`local-phase7/soak-release-attempt2-e2e-report.json:51`). `soak-release-attempt2-FAIL-fcp.txt:1` and `WORKLOG.md:468` omit that. Phase 4 recorded the same override openly.
14. **Loose argument parsing** · nit. `pwa-paint-probe.mjs:54-57` silently ignores `--launches 20` written without `=`, and `:246` rejects `::1`, which `env.mjs:172` treats as loopback.
15. **The entry test leaves temp folders** · nit. `tests/e2e-pwa-paint-probe-entry.test.ts:39`, `:47`, `:67`. Every other `mkdtemp` test in the repo cleans up.
16. **The soak attempt-1 length is unlabelled** · nit · plausible. `WORKLOG.md:467` says 1,128 s, but the file's timestamps span 1,176 s. It may be the season-1 time.
17. **Two lines in the attempt-2 file have no label** · nit. `soak-release-attempt2-FAIL-fcp.txt:5` ("124 = 36000 s bound hit") and `:15` ("[exited with code 0]"). Line 1 states exit 1 correctly.
18. **"16 scenarios" does not match the 15 recorded commands** · nit. `WORKLOG.md:464` against `local-phase7/browser-chain-and-baseline.txt:4-18`.
19. **"All budget gates passed on both builds"** · nit · plausible. `baseline-vs-branch-performance.txt:27`. `perf:budget` ran only on the branch. The baseline's gated scenarios did exit 0.
20. **Merged numbers** · nit. `baseline-vs-branch-performance.txt:5`, `:8` (for example "7.510.300000190734863").
21. **The README keeps a recovery story that attempt 2 disproved** · nit. `tests/e2e/README.md:92-94`: "starting from a closed session recovered a real value".
22. **The scratch SQL has no negative-proof header** · nit. `local-phase7/scratch-stats-ignoring-gate.sql:1-9` is a bare `CREATE OR REPLACE` of a production function. Its comment says "ANY Final game", but the body has no status filter. Nothing loads it.
23. **Summaries stand in for captured output** · nit. `local-phase7/soak-ticks.txt:1` ("PASS 3/3") and `negative-proofs.txt:8` ("all five exit 0").
24. **Ctrl-C leaves probe sessions open** · nit · pre-existing pattern. `pwa-paint-probe.mjs:343-350` has no signal handler, so the owner never disposes. The gate has the same gap (`browser-pwa-launch.mjs:277-285`).
25. **`openCdpClient` leaves the socket open on connect timeout** · nit · plausible · pre-existing. `tests/e2e/browser-agent.mjs:69-81`. The range only exported it, but the probe now calls it on every launch.
26. **Fresh session names use only the PID** · nit · plausible. `pwa-paint-probe.mjs:266`, `:271`. Nothing checks that the session is new. The gate names its sessions the same way.

- Carried unchanged: round-5 items 1–10, round-4 items 10 and 11, and round-3 items 10, 18, 20, 21, 22, 30 and 33.

**Top asks: items 1 and 2, before the next probe run. Items 3–7 are fast-follow. Everything else is minor or nit. Nothing gates.**

## False alarms cleared

- **No stray session with `--launches=1`.** The extra close at `pwa-paint-probe.mjs:302` targets a name the probe chose itself. `agent-browser session list` lags a close by about two seconds, for opened and never-opened sessions alike, and then the session is gone.
- **The seeded password in the evidence is not a leak.** It is derivable from the committed e2e email, but the stack was local-only and has been reset. Production writes need `E2E_ALLOW_PROD_WRITES=1` (`tests/e2e/env.mjs:238-250`). The same pattern is already in phase-3 and phase-4 evidence on `main`.
- **The soak with the mid-life check off cannot pass by mistake.** With the flag off, the required `long.migration` row is `PENDING`, and `tests/e2e/soak.mjs:633` exits 1 under the release gate. CI always sets the flag (`.github/workflows/release-soak.yml:127`). Only the record's wording remains (item 13).
- Also refuted: the real `agent-browser --version` call in unit tests (CI lacks the binary, and it falls back to `'unknown'`), the absolute paths in the evidence (already in more than 20 files at base), `fcpByType === null` against the non-finite gate (JSON turns NaN into `null`), piled-up observer scripts (not reachable at HEAD), `selectCdpPageTarget` picking the wrong page (each session is its own browser with one app page), and three evidence items: exit 143 (it matches the SIGTERM the author admits sending), the season-0 commit subject (corrected in `96443eb`), and the season-1/2 listing (the season-3 summary proves both finished).

## Checked and solid

- **The ownership fix works with the real `createBrowser`.** A hunter drove `runPaintProbeEntry` through the real wrapper, with a fake `agent-browser` binary first on `PATH`. Both launches passed, and each session was closed exactly once. The owner's context spans the whole run (`scenario-resource-owner.mjs:85`), the same as the gate (`browser-pwa-launch.mjs:280`).
- **The gate is not loosened.** `judgeLaunch` fails any timing that is missing, NaN, infinite or negative (`pwa-paint-probe.mjs:217`), and PASS needs a finite `fcpByType`. No defect above can turn a failure into a pass.
- **Session hygiene holds.** Nothing uses `--all`. `closeOwnedSession` names one session (`:132-134`). Fresh sessions close in `finally` (`:294-296`).
- **Mutations the tests kill:** removing the owner wrapper, closing the reused session every launch, adding `--all`, opening the measured page twice, passing on a missing FCP, and dropping the final reused close.
- **Repo checks at HEAD, all exit 0:** `lint`, `lint:all`, `typecheck:e2e`, `typecheck:tests`, `check:dead-code` (knip). Vitest: 123 files and 710 tests at HEAD, against 121 files and 701 tests at `1a98fc2`. The difference is the two new files, with 9 tests.
- **No secrets.** No JWTs and no Supabase keys were added. The only emails are `@example.com`. `tests/e2e-state.json` is gitignored (`.gitignore:43`).
- **The iteration-13 numbers match the evidence:** 307 migrations, 22 of 22 DB suites, edge checks 121 passed and 0 failed, perpetual PASS/PASS/red with 4 FAIL rows/PASS, and FCP 52 ms on the branch and 48 ms on the baseline. Every number in `baseline-vs-branch-performance.txt` matches its four source reports, and the file states direction only, not significance.
- **The release gate is recorded honestly as red and unfinished** (`WORKLOG.md:470`). Nothing claims the fixed probe ran in a real browser (iteration 17: "Not executed against a browser here").
- **The phase-8 run-1 diagnosis is right.** At `cf5cd5b` the probe ran without the owner wrapper, and the error comes from `ownScenarioResource`.
- **The scratch SQL cannot load by accident.** Migrations, the function catalog, the seed and `test:db` all read other paths.

## Coverage caveat

- This is an independent judge pass, not a self-review.
- I reproduced item 1 myself with the real agent-browser. Two agents, working separately, reproduced item 2 on real Chromium. Items 3–5 are reasoned from source and evidence. Item 6's failure path is reasoned from code, not executed.
- I did not run the fixed probe end to end against a seeded stack. A 20-launch probe run from another session was in progress in the main checkout. I did not read its artifacts or touch its sessions.
- There is no remote CI run. The repo checks ran locally, in a scratch copy using the main checkout's `node_modules` at the same commit.
- The ~5,000 lines of generated perf and latency reports were scanned for secrets and spot-checked for the numbers the WORKLOG cites. They were not read line by line.
- **Refutation method:** each material or blocker candidate had its own refuter. Minor and nit candidates were refuted in batches, one batch per dimension, each in a context that did not raise them. Duplicates were merged before counting. The early-observer defect came from two hunters, and the stale header comment from three.
- **Ledger severities:** the ledger has no nit level, so it records every survivor as minor. The minor/nit split above is the refuters' corrected severity. Four survivors are "plausible", not confirmed (items 16, 19, 25 and 26), and they do not gate. Items 8, 24 and 25 are pre-existing patterns that the probe copied.
- **`lessonsctl.py propose` did not run.** `lessonsctl.py propose --log <ledger>` returned `command not found: lessonsctl.py` (exit 127). No `lessonsctl` script exists under the home directory, `~/.claude` or the skill sources, and no lessons inbox exists under `~/.cache`. The 26 survivors and 12 refutations stay in the ledger until the tool exists. Round 5 hit the same gap.

None of these gaps bears on a gating question. Every candidate that could have gated was either reproduced (items 1 and 2) or refuted.

<sub>Evidence is `file:line` at HEAD `c8945c4` vs `1a98fc2`. Ledger: 38 candidates, 12 refuted, 26 survived, every one terminal. An independent judge checked about 45 citations and scored grounding 4, calibration 5, scope honesty 5 and actionability 4. It raised no blocker or material finding against the review, and its four corrections are applied.</sub>

VERDICT: APPROVE
