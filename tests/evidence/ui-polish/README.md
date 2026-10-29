These captures use private stack `pt4bafableup`, ports `628xx`, and a 390 × 844 automation browser. The baseline is `ec739102`. The fixed browser artifact is `770c7bf0`. No production service was contacted.

Lineup shows its existing “Week 2 lineup” title and uses the shared arrow-back button to return to the roster. B23 removed the period actions. The shared header already hid titles beside back controls; 2.7.1 made that titleless close row visible on web. The editor now opts into a visible title. Today, This week, and ROS actions stay removed.

Bracket uses the same arrow-back button and returns to league standings. The removed line is the header’s full-width, one-pixel bottom border at y=111 in the before capture. It is not a sheet grab handle. The application bar keeps its own border. The backup is in the regular season, so these captures show the empty bracket state.

| Screen | Before light | After light | Before dark | After dark |
| --- | --- | --- | --- | --- |
| Lineup | [Before](ui-polish-before/lineup-light.png) | [After](ui-polish-after/lineup-light.png) | [Before](ui-polish-before/lineup-dark.png) | [After](ui-polish-after/lineup-dark.png) |
| Bracket | [Before](ui-polish-before/bracket-light.png) | [After](ui-polish-after/bracket-light.png) | [Before](ui-polish-before/bracket-dark.png) | [After](ui-polish-after/bracket-dark.png) |

Saved-trade Revalue was disabled by the Offers feed’s snapshot mutation gate on a loaded History detail. The before report records zero revalue requests. Revaluation now has a separate disabled state for an active trade action.

The background publication also outlives its ten-minute response deadline. After the button fix, the old SQL returned HTTP 200 with an expired cached response. The UI showed “Trade estimate expired. Try again.” The cache-before run sets only the stored response deadline into the past to reproduce this condition. The migration renews the ten-minute read deadline after checking the current fingerprint. It preserves the valuation timestamp and stored publication. Changed fingerprints cannot reuse that publication.

The original backup has no imported trade values. Its successful estimate requests returned zero and identified missing imported values. See [the raw backup report](raw-backup-report.json). Numeric scenarios import only the checked-in `tests/fixtures/trade-values/onenumberhoops.json` fixture through the local publication RPC. It matches 443 players; see [the import receipt](values.log). No value source was fetched.

Adding Tari Eason changes the total from 107.6 to 510.5. The updated UI appears within 1,352 ms, including a deliberate 600 ms request delay for loading capture. The quote ID and input fingerprint both change. Explicit Revalue sends another successful request. The saved accepted trade displays 1041.6 vs 540 after the stored deadline is expired.

| Theme | Initial | Loading after asset change | Fresh value |
| --- | --- | --- | --- |
| Light | [107.6](ui-polish-after/analyzer-initial-light.png) | [Updating values](ui-polish-after/analyzer-changed-pending-light.png) | [510.5](ui-polish-after/analyzer-changed-fresh-light.png) |
| Dark | [107.6](ui-polish-after/analyzer-initial-dark.png) | [Updating values](ui-polish-after/analyzer-changed-pending-dark.png) | [510.5](ui-polish-after/analyzer-changed-fresh-dark.png) |

[Expired response before SQL](ui-polish-cache-before/analyzer-saved-expired.png) → [readable value after SQL](ui-polish-after/analyzer-saved-expired-dark.png).

The [before report](ui-polish-before/report.json), [cache-before report](ui-polish-cache-before/report.json), and [after report](ui-polish-after/report.json) contain request bodies, responses, UI text, header measurements, and timing. The after run has five HTTP 200 estimate/revalue responses and no page errors. It verifies both back buttons.

The lineup and bracket regressions each failed twice before and pass after. The loading regressions failed twice before and pass after. The snapshot gate regression failed before and passes after. The database lease regression failed before; all seven assertions pass after. The final focused run passes 93 tests on Node 22.23.2. `npm run check:quality` passes on Node 22.23.2.

The final full Node 22 run passes 4,711 tests, skips 48, and has zero failures. After explicit scope approval, [the prepared release note](required-release-note.patch) was applied to `supabase/RELEASE-DB.md`. The release-order guard passes. See [the check record](checks.json), [the release guard result](release-guard.log), and [the full suite result](full-vitest.log). Migration and security attestations were regenerated against the private stack with the repository tool.

The initial broad run used the shell’s Node 26 and was stopped. The complete results above use Node 22. The private stack was stopped and temporary backup copies were deleted; see [the cleanup receipt](stack-receipt.json). Native gestures and a populated postseason bracket were not exercised.

To reproduce on the authorized mini, set `PERF_LAB_LANE=fable-ui21`, `PERF_LAB_PROJECT=pt4bafableup`, `PERF_LAB_PORT_PREFIX=628`, `PERF_LAB_ON_MINI=1`, and `PERF_LAB_TLS_SELF_SIGNED=1`. Set the supplied tool PATH, Docker socket, and Playwright browser path. Put the supplied backup under the lane’s `backup/` folder. Remove the lane’s `stop` marker. Run `node tests/e2e/ui-polish-stack.mjs`, then `node tests/e2e/ui-polish-values.mjs` and `node tests/e2e/ui-polish-browser.mjs after`. Touch the lane’s `stop` marker to clean up.
