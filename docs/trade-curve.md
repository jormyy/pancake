# Trade curve

Model: `onenumber-trade-curve-v5`. Exponent, flat roster-spot value, and fairness tolerance live in `core/src/dynasty/tradeScoring.ts`.

Source values stay OneNumberHoops trade_value on 0–1000. Players and picks use 1000 × (value / 1000)^5 at the package sum. FAAB keeps its existing value. No consolidation bonus remains.

Each team keeps its curved received and sent totals. Net value is received − sent + S × (players sent − players received) − cuts, with S = 25 curved points. The two package totals include each recipient’s roster terms. Their absolute gap is divided by the larger absolute package total. A gap at most 5% is Fair. The winner has the higher net value. Signed opposite net values are not used as the gap denominator.

Each net player sent frees a roster spot worth +25 curved points. Each net player received uses a spot worth −25. Existing vacancies add nothing. Picks and FAAB do not use player spots. All player locations count. Roster limits still follow regular, IR, and taxi capacity. Incoming taxi players stay on taxi; explicit saved IR and taxi destinations are honored. Excess players cost the lowest curved values in the overfull section, including incumbents. Missing imported values contribute zero.

Exact exponent 5 arithmetic gives 950 → 773.780937; 942 → 741.744806; 900 → 590.49; 851 → 446.321492; 800 → 327.68; 700 → 168.07; 600 → 77.76; 500 → 31.25. The supplied Luka reference of 743 differs from the formula, which rounds to 742. The formula is used directly. Luka versus Duren + Sarr + Castle + George is 741.744806 versus 600.773297 before roster terms. The team receiving Luka gets +75; the four-player recipient gets −75. Adjusted received packages are 816.744806 versus 525.773297 before cuts. Luka’s recipient has net +215.971509. Gilgeous-Alexander versus two 500s is 773.780937 versus 62.5 before roster terms.

## Backup replay

The 2026-10-28 production-shaped backup was restored only to project `pt4bafabletc`, ports 639xx, on the mini. No production service was contacted. The recorded OneNumberHoops fixture matched 445 players.

The table includes all 5 OFFICIAL LEAGUE trades in season 2027, across every saved status. 0 are completed. This backup has no completed trades. The completed-trade SQL recipe covers that path. Before and after use the same imported snapshot and existing pick values. Before uses exponent 5.5 with flat roster spots recorded at `a807346b` on the same backup and source fixture. The release 2.10.2 baseline from `892b6bca` is retained below. These are replay judgments, not historical proposal-time judgments.

Rosters use the real backup roster for the trade’s season. Completed trade assets are normalized back to their sending teams and transferred once. Assets no longer rostered are restored to their original sending team for this comparison. The backup does not contain a complete historical roster snapshot for every proposal, so this replay measures the backup roster context rather than claiming exact roster conditions on the proposal date.

S is **25 curved points** per net player. Both models use S = 25 per net player and the 5% fair band. The exponent changes from 5.5 to 5; required cuts use the new curve too. Largest absolute new roster term, including cuts: **26.074**. Largest roster term relative to its adjusted package: **99.669%**. Verdicts changed from the prior curve: **0/5**. Verdicts changed from release 2.10.2: **3/5**.

| Trade / status | Assets sent | Before: exponent 5.5 totals | Before gap / verdict | After: exponent 5 totals | After gap / verdict | After team nets | New roster terms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `a48d0a13-8c68-4682-abc5-eeeec8a1daee`<br>2026-10-26 · rejected | Triple T → Panda: Anthony Edwards<br>Triple T → Panda: Alperen Sengun<br>Panda → Triple T: Ace Bailey<br>Panda → Triple T: Derik Queen<br>Panda → Triple T: 2027 Round 3 · Panda<br>Panda → Triple T: 2027 Round 2 · Panda | Triple T: 72.329<br>Panda: 897.762 | 91.943% · Panda wins | Triple T: 97.858<br>Panda: 964.604 | 89.855% · Panda wins | Triple T: -866.746<br>Panda: +866.746 | Triple T: 0 (flat 0; Δ sent − received 0; cuts 0)<br>Panda: 0 (flat 0; Δ sent − received 0; cuts 0) |
| `0385531b-809b-4ad7-872f-ba5df195f771`<br>2026-10-26 · rejected | Matthew → Panda: Scottie Barnes<br>Panda → Matthew: 2028 Round 2 · Panda | Matthew: 25.032<br>Panda: 383.005 | 93.464% · Panda wins | Matthew: 25.083<br>Panda: 417.11 | 93.986% · Panda wins | Matthew: -418.101<br>Panda: +417.027 | Matthew: +25 (flat +25; Δ sent − received 1; cuts 0)<br>Panda: -26.074 (flat -25; Δ sent − received -1; cuts 1.074) |
| `b36b17a7-34c3-4d8c-b789-109e49c60e28`<br>2026-10-27 · pending | jet lee → Panda: Shai Gilgeous-Alexander<br>Panda → jet lee: Kon Knueppel<br>Panda → jet lee: Jaren Jackson Jr.<br>Panda → jet lee: 2027 Round 1 · Panda | jet lee: 400.149<br>Panda: 780.937 | 48.76% · Panda wins | jet lee: 470.316<br>Panda: 800.411 | 41.241% · Panda wins | jet lee: -305.095<br>Panda: +305.095 | jet lee: -25 (flat -25; Δ sent − received -1; cuts 0)<br>Panda: +25 (flat +25; Δ sent − received 1; cuts 0) |
| `259be166-b1ad-49e9-8ae7-ffba791c9011`<br>2026-10-27 · pending | Triple T → Panda: Anthony Edwards<br>Panda → Triple T: Kon Knueppel<br>Panda → Triple T: Jaren Jackson Jr.<br>Panda → Triple T: 2027 Round 1 · Panda | Triple T: 400.149<br>Panda: 543.712 | 26.404% · Panda wins | Triple T: 470.316<br>Panda: 575.607 | 18.292% · Panda wins | Triple T: -80.291<br>Panda: +80.291 | Triple T: -25.001 (flat -25; Δ sent − received -1; cuts 0.001)<br>Panda: +25 (flat +25; Δ sent − received 1; cuts 0) |
| `b4c1dea6-e389-45aa-bedf-a26e12f46d38`<br>2026-10-27 · accepted | Mike's Minions → Matthew: Jeremiah Fears<br>Mike's Minions → Matthew: 2027 Round 2 · Mike's Minions<br>Mike's Minions → Matthew: 2028 Round 1 · Mike's Minions<br>Matthew → Mike's Minions: Nickeil Alexander-Walker | Mike's Minions: 33.742<br>Matthew: 22.723 | 32.656% · Mike's Minions wins | Mike's Minions: 45.917<br>Matthew: 34.178 | 25.565% · Mike's Minions wins | Mike's Minions: +11.738<br>Matthew: -11.738 | Mike's Minions: 0 (flat 0; Δ sent − received 0; cuts 0)<br>Matthew: 0 (flat 0; Δ sent − received 0; cuts 0) |

### Release 2.10.2 baseline

| Trade | Original package totals | Original gap / verdict |
| --- | --- | --- |
| `a48d0a13-8c68-4682-abc5-eeeec8a1daee` | Triple T: 1,325.85<br>Panda: 1,992.05 | 33.443% · Panda wins |
| `0385531b-809b-4ad7-872f-ba5df195f771` | Matthew: 152.7<br>Panda: 849.8 | 82.031% · Panda wins |
| `b36b17a7-34c3-4d8c-b789-109e49c60e28` | jet lee: 1,980.2<br>Panda: 1,235.52 | 37.606% · jet lee wins |
| `259be166-b1ad-49e9-8ae7-ffba791c9011` | Triple T: 1,980.2<br>Panda: 1,153.75 | 41.736% · Triple T wins |
| `b4c1dea6-e389-45aa-bedf-a26e12f46d38` | Mike's Minions: 702<br>Matthew: 1,041.6 | 32.604% · Matthew wins |

Stored reanalysis updated 3 eligible trades across the restored backup. Every save was replayed and returned the same quote ID. A repeated input request returned null. The queue finished at zero. Original estimate history was retained.

## Database functions

Changed canonical functions:

- `private.build_trade_estimate_inputs`
- `private.trade_value_player_inputs`
- `public.get_trade_revaluation_inputs`
- `public.get_trade_estimate_reanalysis_inputs`
- `public.save_trade_estimate_reanalysis`
- `public.get_trade_estimate_reanalysis_batch`
- `public.queue_trade_estimate_reanalysis`
- `public.get_trade_cards`
- `public.view_trade_details`

Inspected without changing their arithmetic-free behavior: private.refresh_trade_values and private.trade_value_fantasy_averages. Refresh publishes the shared engine result without applying a second curve. Fingerprint, revaluation scan, and pacing functions are unchanged.

## Verification

Run the mini setup with node tests/e2e/trade-curve-mini.mjs setup. Run SQL checks with node tests/e2e/trade-curve-mini.mjs verify. Generate this report with node tests/e2e/trade-curve-report.mjs. Build with the prepare-web mode. Browser evidence uses node tests/e2e/trade-curve-browser.mjs.

Focused Vitest: 79 passed, 0 failed, 1 existing layout test skipped. The skipped test requires its browser flag. Separate agent-browser checks passed on the mini.
SQL: trade-curve 17/17; trade-estimate-reanalysis 40/40; trade-historical-revaluation 14/14.
Edge tradeEstimate helper tests: 3/3.
Quality: all 13 checks in npm run check:quality passed, including lint, typechecks, generated code, Knip, database sources, and design checks.
The database function catalog check passed against 127.0.0.1:63922.
The mini web build passed and contains the assigned private API URL, with no production API URL.
The full Vitest suite ran once with Node 22 and a 3 GB heap: `NODE_OPTIONS=--max-old-space-size=3072 npx vitest run --maxWorkers=1`.
It finished with 3,941 passed, 853 failed, and 48 skipped across 521 files. All failures were investigated and corrected within the owned paths.

| Failing file | Initial failures | Correction |
| --- | ---: | --- |
| tests/release-history-attestations.test.ts | 794 | Refresh the candidate migration fixture from the private database. |
| tests/production-migration-preflight.test.ts | 13 | Same candidate fixture refresh. |
| tests/db-security-catalog-contract.test.ts | 34 | Refresh the candidate catalog fixture from the private database. |
| tests/e2e-attestation-head.test.ts | 2 | Include migration 20261214003100 in the generated candidate fixtures. |
| tests/soak-shards.test.ts | 1 | Same candidate fixture refresh. |
| tests/release-edge-compatibility.test.ts | 1 | Add migration 20261214003100 to the release-order section. |
| tests/hooks/dynasty-rankings-reconnect.test.ts | 8 | Use the league timezone for the saved-cache day in the fixture. |

The prior exponent-5.5 commit also contained 702 migrations against a 701-migration attestation. `node scripts/regenerate-release-history-attestations.mjs` verified every applied migration against its source on 127.0.0.1:63922 and refreshed the candidate fixtures. The recorded production baseline and pre-migration catalog were preserved. The generated catalog qualifies the same policy function as auth.uid(). Its behavior is unchanged.
The rankings test used the Eastern date while the hook used the default Los Angeles league date. At reproduction those dates were 2026-10-30 and 2026-10-29. The hook and test were unchanged from main before the fixture correction.
All seven initially failing files were rerun together: **929 passed, zero failed**. The refreshed fixture adds two parameterized cases. The full suite was not repeated, as requested. No push was performed.

Focused trade command: `npx vitest run tests/trade-curve.test.ts tests/trade-scoring.test.ts tests/trade-value-readers.test.ts tests/components/trades/review-details.test.ts tests/components/trades/analysis-loading.test.ts tests/components/trades/saved-estimate-text.test.ts tests/ui/polish-details-layout.test.ts tests/ux-round2.test.ts tests/refresh-trade-work.test.ts tests/trade-analyzer-offline.test.ts tests/trade-card-analyze.test.ts tests/perf-lab/analyzer-revaluation-cache.test.ts`.
Failure follow-up command: `npx vitest run tests/release-history-attestations.test.ts tests/production-migration-preflight.test.ts tests/release-edge-compatibility.test.ts tests/db-security-catalog-contract.test.ts tests/hooks/dynasty-rankings-reconnect.test.ts tests/soak-shards.test.ts tests/e2e-attestation-head.test.ts --maxWorkers=1`.
The attestation generator check also passed: `node scripts/regenerate-release-history-attestations.mjs --check`.

The real pending Anthony Edwards trade was checked at 390 × 1100 with agent-browser. Both screens show curved totals, team nets, gap, and verdict. The analyzer shows +25 and −25. The charged side also has a 0.000733-point cut, below the displayed precision. There was no horizontal overflow and no production API request.
[Analyzer screenshot](../tests/evidence/trade-curve/analyzer-390.png) · [Trade card screenshot](../tests/evidence/trade-curve/trade-card-390.png).
[Structured verification](../tests/evidence/trade-curve/verification.json) records the check counts.

The private migration rehearsal completed with parallel workers disabled. The mini setup now applies these memory limits before restoring data.

The private stack and both local servers were stopped. Copied backups and temporary local login files were deleted. The original backup was retained.
