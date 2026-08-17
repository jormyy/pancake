# Season Autonomy Ledger

Machine-readable status per acceptance criterion from
`~/Documents/Goals/pancake/pancake-perpetual-season-autonomy-goal.txt`.
Regenerated whenever a criterion closes.

Format: `<ID> | <PASS/FAIL/PENDING> | <evidence pointer>`

```
AC-01 simulated-season-passes        | PASS    | npm run e2e:perpetual -> PASS: weeks finalize, bracket auto-generates/advances, season auto-rolls, matchups generate, rookie draft backstop reactivates league, new-season week scores; zero manual calls
AC-02 calendar-config-alignment      | PASS    | perpetual harness: regular season spans 1..psw-1 (psw 20/22/18), first playoff round at configured week, week-1 scoring asserted
AC-03 two-consecutive-rollovers      | PASS    | npm run e2e:perpetual (rollovers=2, 4 leagues incl. 10-team QF bracket) -> PASS
AC-04 harness-forced-red             | PASS    | npm run e2e:perpetual -- --disable-boundary -> FAIL (3 bracket-not-generated failures), report.json status FAIL
AC-05 boundary-cron-idempotent       | PASS    | assertBoundaryIdempotent: boundary re-run after each transition changes no matchup/season rows
AC-06 stat-correction-safety         | PASS    | Grace scenario: boundary waits 48h; in-window correction re-decides semifinal; post-advancement correction updates stats but closed matchup immutable
AC-07 rollover-completeness          | PASS    | assertRolloverCompleteness: inverse-standings waiver priority, FAAB=configured, add counters zero, rookie_draft_scheduled_at default stamped
AC-08 rookie-draft-backstop          | PASS    | assertRookieDraftBackstop: unrun draft auto-completed best-available at week 1; all picks rostered, none on waivers, league active
AC-09 offseason-fully-open           | PASS    | runOffseasonOpenScenario: offseason add/drop/waiver claim+processing/trade succeed; trade lands in new-season rosters and pick ledger
AC-10 commissioner-override-compat   | PASS    | Manual league: commissioner generates/advances/rolls first; automation tick only backfills matchups, seasons count stays exact
AC-11 schedule-freshness-offseason   | PASS    | tests/lib/schedule-freshness.test.ts: offseason stale -> skip; in-season stale + label mismatch still throw; sync-schedule short-circuits on skip
AC-12 oct-10-season-year-gap         | PASS    | supabase/functions/_shared/octoberGap.test.ts: Oct 10 mocked date, no new-season data -> syncScores and season-boundary complete with zero writes
AC-13 syncscores-bounded-fanout      | PASS    | syncScores runBounded fan-out (concurrency 8) with per-league isolation; supabase/functions/_shared/syncScoresFanout.test.ts: failing league A, league B completes; total wipeout still fails
AC-14 waiver-drain-150               | PASS    | process-waivers drains batches until empty; harness waiver-drain scenario: 160 due claims across 4 leagues, 0 pending after one run
AC-15 retention-tested               | PASS    | prune_unbounded_history() + weekly cron; tests/db/retention-pruning.sql: out-of-window pruned, product-read rows (final standings, current lineups, 3 seasons transactions, recent runs) kept
AC-16 sleeper-migration-parity       | PASS    | ESPN keyless source cut over (PLAYER_SYNC_SOURCE default espn, sleeper dormant); 3 consecutive parity syncs in docs/sleeper-migration.md (coverage 96.1% of rostered, team 99.3%, injury agreement 100%); espn_id additive, sleeper IDs resolve (fallback run updated 544 existing rows)
AC-17 scrape-degraded-modes          | PASS    | per-source degraded tests: NBA CDN (_shared/nbaCdnDegraded.test.ts down/garbage/reshaped/recovered), ESPN replacement (_shared/playerSource.test.ts down/garbage/truncated/empty/recovered), FantasyPros (parser.test.ts broken-HTML -> 0 rows -> skipped run; per-source catch + internal fallback in index), HashtagBasketball (parser tests + MIN_RANKING_ROWS refusal client+DB p_min_rows), Sleeper dormant path exercised in release soak
AC-18 draft-order-automation         | PASS    | sync-draft-order/degraded.test.ts: failed window day writes nothing + prior order intact; incomplete board refused; next window day syncs full board; June/July guard tested
AC-19 db-integrity-post-sim          | PASS    | runDbIntegrityChecks: no orphan matchups/lineups/standings, single current season, unique years, <=1 final/season, games within season_weeks
AC-20 full-suite-green               | PASS    | npm test: 594 passed (post-review); deno edge suite: 95 passed; lint/typecheck/knip/db-parity/edge-shared/db-types all green 2026-08-15
AC-21 no-unresolved-findings         | PASS    | michael-review (self-review, adversarial): 42 candidates, 29 refuted, 13 survived (1 blocker, 5 material, 7 minor) - all 13 fixed and re-verified; see checkpoint below
AC-22 soak-20-seasons-green          | PASS    | npm run e2e:soak:release: 20/20 seasons PASS, coverage PASS (2026-08-15 run, ~4h), midlife migration APPLIED at season 5->6; findings fixed: sync-stats ISO date, offseason wire-log expiry, rotted auction/waiver-push/realtime scenarios, trade fixture routing, disposal FK + transient retry
AC-23 soak-offseason-activity        | PASS    | soak-offseason-activity.mjs runs EVERY season (20/20 artifacts, zero failures): add, drop, processed claim, two-team player+pick trade, multi-team trade, settings change, full rookie draft - all survive rollover
AC-24 soak-harness-trustworthy       | PASS    | docs/soak-harness-audit.md: 7 forced-red mutations all RED-PROVEN then restored green; no always-green scenarios; 3 always-red rotted scenarios + 1 flake found and fixed
```

## Checkpoint log

- 2026-08-17 Dynasty decision tools release proof: production migrations `20260816000002` and `20260816000003` applied; `npm run e2e:soak:release` passed 20/20 seasons in 4h 6m 20s; the new decision-tool checks passed every season; the mid-life migration applied between seasons 5 and 6; realtime WebSocket and expired-session harness failures were fixed before the complete rerun; the 22-step production-export browser walkthrough passed at 1440x1000 and 390x844 with zero final page errors.

- 2026-08-15 Production incident found and fixed while investigating Dynasty Hub staleness: every cron->edge invocation had failed since 2026-06-28 ("Supabase Edge base URL is not configured" - the 20260628000007 fail-closed invoker required an app.supabase_url GUC that managed Supabase forbids setting). Fixed with a Vault URL fallback (migration 009) + prod secret; catch-up synced the 2026-27 schedule (1200 games/25 weeks), completed a trade stuck since June, and revived all pipelines. Rankings had additionally rotted (Hashtag card redesign) - parser rewritten with real-fixture test; floor 500->300 (site now lists 400). dynasty_news had never had a writer - ESPN news ingestion added to sync-players with 60-day retention. Mock rooms gained delete (RPC+route+UI) and daily auto-expiry (migration 010/011).

- 2026-08-15 Finish: /deslop pass (lint-ignore markers), /michael-review with adversarial refuters: 42 candidates, 29 refuted, 13 survived, all fixed:
  BLOCKER - cron idle gate excluded offseason leagues (backstop dead all summer; migration 007 + tests/db/season-boundary-gate.sql);
  material - zero-matchup active seasons now backfill; offseason add-week freeze fixed (migration 008, executed-verified 1001); coarse ESPN G/F startable in core+DB+scoring maps; ambiguous-name dup forking refused and counted;
  minor - injury name-uniqueness, honest backstop partial reporting, deterministic draft pick, vacuous Oct-gap test fixed, standings-empty loud failure, years_exp parity documented (rookie=0 identical).
  Post-fix verification: vitest 594, deno 95, perpetual harness PASS, browser DOM render check PASS.

- 2026-08-15 Wave 8: 20-season release soak green end-to-end locally with busy offseason every season; forced-red audit of the soak harness complete (docs/soak-harness-audit.md).

- 2026-08-14 Wave 7: scrape degraded-mode tests complete for all active sources + dormant fallback; draft-order automation window behavior tested.

- 2026-08-14 Michael added Wave 8 (AC-22..AC-24): npm run e2e:soak:release must run green before the finish step, with findings fixed and recorded here.

- 2026-08-14 Wave 6: Sleeper -> ESPN migration with live local cutover verification (insert 546 / re-run update 546), dormant sleeper flag verified, degraded-mode tests for the new source.

- 2026-08-14 Wave 5: bounded league fan-out, waiver full drain, retention pruning with tested windows.

- 2026-08-14 Wave 4: schedule freshness offseason-aware (skip May-Aug, fail Sep-Apr); Oct-gap covered by design (league_seasons-driven scoring) with regression test.

- 2026-08-14 Wave 3: 48h grace + playoff immutability, rollover completeness (year derivation fix, rookie_draft_scheduled_at default), rookie-draft week-1 backstop, offseason fully opened (adds/drops/waivers/trades incl. accepted-trade trigger + waiver candidate selection).

- 2026-08-14 Waves 1-2: season-boundary automation + perpetual harness landed; green and forced-red runs shown. AC-01 held PENDING until the rookie-draft week-1 backstop replaces the harness's interim offseason->active flip.
- 2026-08-14 Wave 1 started. Baseline recorded: `npm test` green (588 tests, 100 files).
