# Season Autonomy Ledger

Machine-readable status per acceptance criterion from
`~/Documents/Goals/pancake/pancake-perpetual-season-autonomy-goal.txt`.
Regenerated whenever a criterion closes.

Format: `<ID> | <PASS/FAIL/PENDING> | <evidence pointer>`

```
AC-01 simulated-season-passes        | PENDING |
AC-02 calendar-config-alignment      | PASS    | perpetual harness: regular season spans 1..psw-1 (psw 20/22/18), first playoff round at configured week, week-1 scoring asserted
AC-03 two-consecutive-rollovers      | PASS    | npm run e2e:perpetual (rollovers=2, 4 leagues incl. 10-team QF bracket) -> PASS
AC-04 harness-forced-red             | PASS    | npm run e2e:perpetual -- --disable-boundary -> FAIL (3 bracket-not-generated failures), report.json status FAIL
AC-05 boundary-cron-idempotent       | PASS    | assertBoundaryIdempotent: boundary re-run after each transition changes no matchup/season rows
AC-06 stat-correction-safety         | PENDING |
AC-07 rollover-completeness          | PENDING |
AC-08 rookie-draft-backstop          | PENDING |
AC-09 offseason-fully-open           | PENDING |
AC-10 commissioner-override-compat   | PASS    | Manual league: commissioner generates/advances/rolls first; automation tick only backfills matchups, seasons count stays exact
AC-11 schedule-freshness-offseason   | PENDING |
AC-12 oct-10-season-year-gap         | PENDING |
AC-13 syncscores-bounded-fanout      | PENDING |
AC-14 waiver-drain-150               | PENDING |
AC-15 retention-tested               | PENDING |
AC-16 sleeper-migration-parity       | PENDING |
AC-17 scrape-degraded-modes          | PENDING |
AC-18 draft-order-automation         | PENDING |
AC-19 db-integrity-post-sim          | PASS    | runDbIntegrityChecks: no orphan matchups/lineups/standings, single current season, unique years, <=1 final/season, games within season_weeks
AC-20 full-suite-green               | PENDING | baseline 2026-08-14: npm test -> 588 passed (100 files)
AC-21 no-unresolved-findings         | PENDING |
```

## Checkpoint log

- 2026-08-14 Waves 1-2: season-boundary automation + perpetual harness landed; green and forced-red runs shown. AC-01 held PENDING until the rookie-draft week-1 backstop replaces the harness's interim offseason->active flip.
- 2026-08-14 Wave 1 started. Baseline recorded: `npm test` green (588 tests, 100 files).
