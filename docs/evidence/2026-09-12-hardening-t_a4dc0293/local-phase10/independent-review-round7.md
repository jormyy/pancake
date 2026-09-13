# Review — `task/t_a4dc0293-hardening`, round 7

**Approve.** Nothing gating survived. This range repairs the paint probe and corrects evidence text. It changes no product code. The two round-6 defects that stopped the probe from measuring are fixed and work on real Chromium. But several WORKLOG "Fixed" claims are false, and the signal-handler fix does nothing.

Reviewed `c8945c4..24d4768`: 2 commits, 18 files, +1,103/−256. The range touches only `tests/`, `docs/evidence/` and `WORKLOG.md`. There were five hunt dimensions: probe measurement (the crown jewel), session lifecycle and signals, test quality by mutation, evidence and docs honesty, and one unsteered cross-cutting sweep. For each candidate, an agent that did not raise it tried to refute it.

**36 raised / 9 refuted / 27 survived (0 blocker, 0 material, 9 minor, 18 nit).** None gates.

**The probe can now measure: its parser and early observer both work on real Chromium. What does not hold is the record of the repair. Of the 26 rows in iteration 19, two "Fixed" rows are false (round-6 items 18 and 24), and six are only partly true (items 3, 7, 8, 12, 22 and 23). The row for item 2 also overclaims its tests (findings 1, 2, 3, 5 and 8 below).**

## Round-6 scorecard

`git diff --stat c8945c4..24d4768 -- app lib core hooks components supabase scripts .github package.json` is empty. Round-5, round-4 and round-3 carried items are unchanged.

| Round-6 item | Status at `24d4768` |
| --- | --- |
| 1 — parser cannot read real `eval` output | **Fixed, verified.** Real agent-browser 0.25.4 awaits the async `PAINT_STATE` and prints a double-encoded string; `parseEvalJson` (`pwa-paint-probe.mjs:80-85`) decodes it |
| 2 — early observer dropped before the page loads | **Fixed in code, verified on real Chromium** (registered, `ran: true`, script removed after `finish()`). The call order is untested (item 3) |
| 3 — gate status blames the host | **Half.** The gate paragraph (`WORKLOG.md:470-475`) is fixed. `:481-484` still cites `relaunch.png` (item 2) |
| 4 — probe measures a different launch | **Fixed**, with small deviations (item 22) |
| 5 — failed setup records zero attempts | **Fixed**; a test kills the mutation |
| 6 — fake cannot fail a close | **Fixed**; the fake matches `createBrowser`'s order |
| 7 — tests do not prove the claims | **Mostly fixed.** Five of the six named mutations are killed. The reused-prelude one survives (item 5) |
| 8 — main guard skips main on some paths | **Half.** Spaces work. A symlinked path still does nothing (item 8) |
| 9, 10, 11, 14, 15, 16, 17, 19, 20, 21, 26 | **Fixed** |
| 12 — stale header | **Fixed**, except the screenshot sentence (item 26) |
| 13 — mid-life override not in soak records | **Fixed** for attempt 2. Attempt 1's flag is not shown by a retained file (item 12) |
| 18 — "16 scenarios" | **Not fixed**, though marked Fixed (item 2) |
| 22 — scratch SQL header | **Half.** Line 5 contradicts the new header (item 11) |
| 23 — summaries stand in for output | **Half.** `negative-proofs.txt` is fixed; `soak-ticks.txt` is untouched (item 2) |
| 24 — Ctrl-C leaves sessions open | **Not fixed**, though marked Fixed (item 1) |
| 25 — `openCdpClient` connect leak | **Fixed** for the connect path. A pre-existing post-open stall remains (item 4) |

## Gating

None.

## Pre-merge asks (not gating)

### 1. The SIGINT/SIGTERM handler closes no session · minor · pre-merge ask · [VERIFIED]

`tests/e2e/pwa-paint-probe.mjs:397-405`, with `tests/e2e/browser-agent.mjs:243` and `tests/e2e/scenario-resource-owner.mjs:65`. The claim is at `WORKLOG.md:580`.

```js
const onSignal = (signal) => {
  Promise.allSettled([...ownedSessions].map((session) => browser(session, ['close']).catch(() => {}))).finally(() => {
```

**The listener runs outside the scenario owner, so every close throws before it reaches agent-browser, and the throw is swallowed.**

- `createBrowser` calls `ownScenarioResource` first. With no owner it throws "Cannot own browser session … without an active scenario resource owner". Then `process.exit()` skips `owner.dispose()`.
- Three agents reproduced this separately. Each used a fake `agent-browser` on `PATH` with the real `createBrowser`. After SIGTERM or SIGINT the exit code is 130, and the argv log has no `close`. A control run with no signal logs the close.
- No test covers the signal path. The test fake skips the owner check.
- **Why not gating:** it fails open only on a manual, loopback-only diagnostic. `c8945c4` had no handler, so it leaked the same sessions. It is not a regression. But the WORKLOG row is false.
- **Fix:** capture the owner and call `owner.dispose()` in the handler, or run the closes inside `runWithScenarioResourceOwner`. Stop the launch loop before closing. Test it by sending the signal to a child process that uses the real `createBrowser` and a fake binary.

### 2. Three WORKLOG rows say "Fixed" for fixes that did not land · minor · pre-merge ask · [VERIFIED]

`WORKLOG.md:559` (item 3), `:574` (item 18), `:579` (item 23).

- Item 3 says "`relaunch.png` citation dropped". `WORKLOG.md:482` still reads "`relaunch.png` shows the app", and `:481-484` still says "the paint happened; the engine did not report …".
- Item 18 quotes "15 recorded commands, then the full-sweep smoke". `WORKLOG.md:464` still says "browser chain (16 scenarios)". The quoted phrase is nowhere in the repo.
- Item 23 says `soak-ticks.txt` now states what was captured. That file is not in this range's diff.
- **Why not gating:** it is a false record, and no gate or product state depends on it.
- **Fix:** make the three edits, or change the rows to "Not fixed". Also correct items 2, 7, 8 and 24 as items 1, 3, 5 and 8 below describe.

### 3. No test pins when the probe finishes the early observer · minor · pre-merge ask · [VERIFIED]

`tests/e2e-pwa-paint-probe-entry.test.ts:184-199`, against `tests/e2e/pwa-paint-probe.mjs:329-344`. The claim is at `WORKLOG.md:558`.

```ts
const closeIndex = calls.findIndex((c) => c.args[0] === 'close')
expect(log[0]).toBe('finish')
expect(closeIndex).toBeGreaterThan(-1)
```

**The test's name says "finishes it after the read", but it compares no order.** `finish` and the browser calls sit in separate arrays.

- Three agents moved `await early.finish()` to just before the measured open, which is round-6 item 2's defect. All 18 tests still passed. Moving it before the read, or after the close, also passed.
- The unit test at `:165-176` pins order inside `beginEarlyObserver` only.
- **Why not gating:** the regression fails safe. The observer does not run, so the launch files as `missing:no-evidence`, and the gate still fails it.
- **Fix:** log `finish` into the same `calls` array. Assert it comes after the `/roster` open and the `PAINT_STATE` eval, and before that session's close.

### 4. The local release-soak recipe resets the database but never seeds it · minor · pre-merge ask

`tests/e2e/README.md:136` (`supabase db reset`), then `:142` (`npm run e2e:soak:release`).

- A reset wipes the seeded league and users, so `tests/e2e-state.json` goes stale. CI seeds in its "Seed release fixture" step.
- `WORKLOG.md` iteration 19 says the next soak runs "configured as documented".
- **Why not gating:** the soak fails loud. With no state file, `soak.mjs:98-99` throws. With a stale one, `soak-support.mjs:521` throws before season 1. It cannot pass by mistake.
- **Fix:** add `npm run e2e:seed` after the `mv` back. State the other prerequisites: functions served, and the stamped release build served on `E2E_FRONTEND_URL`.

### 5. The reused-prelude test checks a label, not behaviour · minor · pre-merge ask · [VERIFIED]

`tests/e2e-pwa-paint-probe-entry.test.ts:78-79`, against `tests/e2e/pwa-paint-probe.mjs:320` and `:323`. The claim is at `WORKLOG.md:563`.

- `:78` asserts `record.prelude`, which `:320` computes from `reusedPreludeDone`. `:79` checks `setupAttempts` on fresh launches only.
- Changing `:323` to `if (true)` makes every reused launch rerun the full prelude. All 18 tests still pass, and the record still says "none (session already signed in)".
- **Fix:** assert the reused session's opens are `/`, `/`, `/roster`, `/roster`, `/roster`, and its `setupAttempts` are `[2, 0, 0]`.

### 6. The signed-in entry test is weaker than its name · minor · pre-merge ask · [VERIFIED]

`tests/e2e-pwa-paint-probe-entry.test.ts:95-112`. The README claim is at `tests/e2e/README.md:114-115`.

- The fake's `snapshot` returns `''`, so `fillSignInCredentials` never succeeds, and the test discards `failed` (`void failed`, `:103`).
- Each of these still passes 18 of 18: removing the fill loop (`pwa-paint-probe.mjs:251-253`), the click (`:254`), `localStorage.clear` (`:246`) or the `WAIT_MS` wait (`:334`).
- The README says "every attempt is counted". Only navigations raise `setupAttempts`. The eight fill retries and the 20 readiness polls are not counted.
- **Fix:** make the fake's snapshot return email and password textboxes. Assert the order clear, fill, click, 2000 ms wait, measured open. Assert `failed === 0`. Say "every navigation attempt" in the README.

### 7. The report's summary counts are untested · minor · pre-merge ask · [VERIFIED]

`tests/e2e/pwa-paint-probe.mjs:356-362`.

- Hardcoding `summary.fresh.pass`, `summary.reused.total` or `summary.earlyObserverRan` to 0 still passes 18 of 18. Only `buckets.pass`, the bucket total and `failed` (`:384`) are asserted.
- **Fix:** assert the full `summary` object in the six-launch entry test.

### 8. Started through a symlinked path, the probe does nothing and exits 0 · minor · pre-merge ask · [VERIFIED]

`tests/e2e/pwa-paint-probe.mjs:413`. The claim is at `WORKLOG.md:564`: "Fixed in the probe (`pathToFileURL`)".

- `import.meta.url` holds the real path. `process.argv[1]` keeps the symlink. `pathToFileURL` fixes spaces, not symlinks.
- Two agents ran it. `node /tmp/…/pwa-paint-probe.mjs` exits 0 with no output and no agent-browser call. The same file through `/private/tmp/…` runs. This checkout sits under `/private/tmp`.
- The defect predates this range (`c8945c4` failed the same way). `npm run e2e:pwa-paint-probe` works.
- **Fix:** compare `fileURLToPath(import.meta.url)` with `realpathSync(process.argv[1])`. Or reword the WORKLOG row.

## Post-merge tracker

9. **The evidence never records the browser build, so the season-3 cause cannot be tested** · minor · plausible · pre-existing. The gate and soak evidence under `docs/evidence/2026-09-12-hardening-t_a4dc0293/` records no user agent. A refuter compared every recorded paint result with `pmset -g log`. Each recorded pass fell while the display was on. Both recorded misses fell while it was off: phase 5 (16:59–17:13 PDT) and soak season 3 (19:23 PDT). With the display off, Chrome 147, agent-browser's default download, produced no paint entry and 0 frames. Chrome 153 painted at 62 frames per second. **This is a strong lead, not a proven cause.** It is also the most useful fact for the next soak decision. **Fix:** record the user agent and display state in the gate report. Run the probe and the soak on a known build with `caffeinate -d`.
10. **SIGTERM exits 130** · nit. `pwa-paint-probe.mjs:399`. 143 is conventional.
11. **The scratch SQL contradicts its own header** · nit. `local-phase7/scratch-stats-ignoring-gate.sql:5` still says "ANY Final game" under the new header that says there is no status filter.
12. **The attempt-1 flag has no retained proof** · nit · plausible. `soak-release-attempt1-STOPPED-partial.txt:1` and `WORKLOG.md:467` say attempt 1 ran with `E2E_ENABLE_MIDLIFE_MIGRATION=0`. Only attempt 2's report proves the flag.
13. **"The paint probe above" is below** · nit. `tests/e2e/README.md:96`. The probe paragraph starts at `:99`.
14. **An older README sentence contradicts the new section** · nit · pre-existing. `tests/e2e/README.md:203` still describes the plan as "the sorted repository migration head … the preceding schema".
15. **"The newest migration on main" stands in for the deployed schema** · nit · plausible. `tests/e2e/README.md:133`. It is true today (`20260823000001` is the newest on `origin/main`).
16. **The recipe has no restore trap** · nit. `tests/e2e/README.md:135-137`. A failed reset leaves three migrations in the temp folder, `*.sql` sweeps in stale files from an earlier run, and `$TMPDIR` is unset on Linux. Each failure is loud.
17. **A hand-made session is called "probe-owned"** · nit. `local-phase9/raw-eval-diagnosis.txt:1` and `WORKLOG.md:544`.
18. **The Supabase guard and the verify-error throw are untested** · nit. `pwa-paint-probe.mjs:288`, `:304`. Removing either still passes 18 of 18.
19. **`early-error` vs `early-saw` precedence is unpinned** · nit. `pwa-paint-probe.mjs:211-212`. Swapping the lines passes 18 of 18.
20. **The fake's `cdpUrl` option is never set** · nit. `tests/e2e-pwa-paint-probe-entry.test.ts:29`, `:44`. No test runs the real `beginEarlyObserver` inside `runPaintProbe`.
21. **A failed reused close counts as a launch** · nit. `pwa-paint-probe.mjs:354`, `:384-385`. 20 launches can print as "x/21".
22. **"The gate's prelude, verbatim" is not verbatim** · nit. `pwa-paint-probe.mjs:241-243`. The probe skips the gate's signed-out state read and document fetch (`browser-pwa-launch.mjs:143-154`), and it adds a CDP attach and `Page.enable` (`:160-162`) before the measured open. The skipped steps are read-only.
23. **A failed script removal is lost** · nit. `pwa-paint-probe.mjs:330` copies the outcome before `finish()` writes `removeError` (`:178`). Executed: the error is in neither report.
24. **`closeError` is missing from report.md** · nit. Set at `pwa-paint-probe.mjs:346`; the table at `:380-381` has no column. `report.json` keeps it.
25. **A stderr line after the result becomes a probe error** · nit. `browser-agent.mjs:65` joins stdout and stderr, and `parseEvalJson` takes the last line. It fails loud, and the gate has the same behaviour.
26. **The header treats the screenshot as proof of paint** · nit. `pwa-paint-probe.mjs:16` ("the screenshot showed the app") and the decision rule at `WORKLOG.md:500`. On darwin the screenshot is `Page.printToPDF` (`browser-agent.mjs:34`, `:143`), which needs no drawn frame.
27. **A post-open socket drop stalls `finish()` for 10 s** · nit · pre-existing. `openCdpClient` (`browser-agent.mjs:78-112`) has no `close` listener to reject pending sends. The stall is after the read, so it never changes a measurement.

- Carried unchanged: round-5 items 1–10, round-4 items 10 and 11, and round-3 items 10, 18, 20, 21, 22, 30 and 33.

**Top asks: items 1 and 2, because the record says they are fixed. Items 3–8 are fast-follow. Item 9 is the lead to follow before the next soak. Everything else is nit. Nothing gates.**

## False alarms cleared

- **Display sleep does not break the probe as it runs now.** A hunter saw no paint and 0 frames with the display asleep. That session ran Chrome 147. The probe runs Chrome 153, which painted with the display off. Only the residue survives, as items 9 and 26.
- **The log line at `pwa-paint-probe.mjs:352` cannot crash on real output.** `PAINT_STATE` always returns an object whose paint fields are arrays, and a failed or null eval lands inside the `try`.
- **The Supabase guard cannot lead to a production write.** A production bundle served on loopback would pass the guards. But the seeded credentials are new on each run, seeding refuses production without `E2E_ALLOW_PROD_WRITES=1` (`env.mjs:242-251`), and sign-in writes nothing.
- **The probe loop does not race the signal handler at HEAD.** The handler exits about 1 ms after the signal, because every close throws at once. This becomes reachable only when item 1 is fixed.
- Also refuted: the unopened reused-session close with `--launches=1` (real agent-browser exits 0 and leaves no process), the sign-in poll's untrimmed `innerText` (whitespace-only root text at `/` is not a real state), `javascript://localhost` passing the loopback check (the only input is the operator's own URL), the cwd-relative fixture path (the module already reads its budgets relative to the working directory), and "run-2 evidence lacks the reused-launch timing" (each launch's start and finish times are in `report.json`).

## Checked and solid

- **Repo checks at HEAD, all exit 0:** `lint:all`, `typecheck:e2e`, `typecheck:tests`, `check:dead-code`. Vitest: 123 files and 719 tests, the same as `WORKLOG.md` iteration 19.
- **The parser works on real output.** agent-browser 0.25.4 awaits an async eval and prints a double-encoded string. `parseEvalJson` (`pwa-paint-probe.mjs:80-85`) matches the gate's parser (`browser-pwa-launch.mjs:31-35`) and decodes the retained raw sample.
- **The early observer works on real Chromium.** Through the real `openCdpClient` inside a scenario owner, it registered, the page exposed its store on the next open (`ran: true`), and after `finish()` the next page had no store.
- **The gate is not loosened.** `judgeLaunch` (`pwa-paint-probe.mjs:201-216`) checks for a finite FCP first. Every path returns one bucket. Mutations that pass `early-none`, make the budget inclusive or drop the owner wrapper are killed.
- **Session hygiene holds on a normal run.** With a fake binary and the real `createBrowser`, each fresh session got one `close` after its launch (`:345-347`), and the reused session got one at the end (`:354`). Nothing uses `--all`. A failed close stays owned, and the owner's dispose retries it.
- **The loopback guard fails closed.** It rejects `localhost.evil.com`, `127.0.0.1.nip.io`, `127.0.0.1@evil.com`, `[::ffff:127.0.0.1]` and `0.0.0.0` (`:71-73`, `:287-288`).
- **The test fake matches `createBrowser`.** It claims ownership before every command, releases only after a successful close, and closes for real on dispose (`browser-agent.mjs:241-264`).
- **Mutation testing:** of 49 single mutations of the probe, 23 were killed and 26 survived. Items 3 and 5–7 list the survivors that matter.
- **The README migration facts are correct.** `20260823000001` is the newest migration on `origin/main`, and the branch adds `20260912000001..3`. The plan script accepts the positional form and emits `pendingFiles`, `repositoryHead` and `pendingVersions`. The harness reads every `E2E_MIDLIFE_*` variable the recipe sets.
- **The run-2 evidence is consistent** with the probe code at `c8945c4`, which is the code that ran. The md, txt and json files agree.
- **No secrets.** The only emails are `@example.com`, and the test credentials are `'pw'` and `'x'`.
- **The scratch SQL cannot load.** `supabase/config.toml:58` and `:65`, `scripts/check-db-function-sources.mjs:7-9` and the `test:db:*` scripts all read other paths.

## Coverage caveat

- This is an independent judge pass, not a self-review.
- **Every item marked [VERIFIED] was executed.** Items 2 and 4 are grounded in the files, not executed. Item 9 is a correlation from the power log, not a proven cause.
- I did not run the probe end to end against a seeded stack, and I did not run the README recipe. A refuter dry-ran only the plan script and the file moves.
- Another session was running a 20-launch probe on the host. No reviewer touched its sessions. One refuter read its report without changing it: 20 of 20 launches passed on Chrome 153.
- **Side effect on that run:** a hunter ran `caffeinate -u` and woke the display from 21:24:56 to about 21:25:26 PDT. That window covers launch 1 of that run. A display-sleep assertion from an unknown source held until 21:28:30, covering launches 2–20. So that run is not a clean display-off sample. The refuter's own Chrome 153 sessions, run later with no assertion and the display off, still painted.
- There is no remote CI run. The checks ran locally, in a scratch copy using the main checkout's `node_modules`, at the same commit with the same lockfile.
- The mutation work covered `pwa-paint-probe.mjs` only, not `browser-agent.mjs` or the gate.
- **Refutation method:** each candidate went to a refuter that had not raised it. The signal claim and the display claim each had their own refuter. The smaller items were refuted in batches, one per dimension. Duplicates were merged before counting: the signal defect came from three hunters, and the finish-order gap, the x/21 count, the prelude deviations and the `:352` log line from two each.
- One hunter's line numbers for the test files did not match the files. I re-grounded those citations against the files at `24d4768`. Another hunter reported that the `/tmp` path runs main. Its run exited 1, which does not show that main ran. Two other runs showed exit 0 and no output.
- **Ledger severities:** the ledger has no nit level, so it records every survivor as minor. The minor/nit split above is the refuters' corrected severity. Three survivors are plausible, not confirmed (items 9, 12 and 15). None gates.
- **`lessonsctl.py propose` did not run.** `lessonsctl.py propose --log <ledger>` returned `command not found: lessonsctl.py` (exit 127). No `lessonsctl` script exists under the home directory, `~/.claude` or the skill sources, and no lessons inbox exists under `~/.cache`. The 27 survivors and 9 refutations stay in the ledger. Rounds 5 and 6 hit the same gap.

None of these gaps bears on a gating question. Every candidate that could have gated was refuted, reproduced or proven safe-direction.

<sub>Evidence is `file:line` at HEAD `24d4768` vs `c8945c4`. Ledger: 36 candidates, 9 refuted, 27 survived, every one terminal.</sub>

VERDICT: APPROVE
