Pending asset reservations now show one 16 px MaterialIcons lock in the muted badge colour. Player rows keep it beside Yr. Pick rows keep it beside the pick label. Tap and long press show the short reason without source IDs. Multiple reservations share one icon.

Changed rendering surfaces and source files:

- Roster cards, taxi rows, read-only team rows, roster table, roster picks, and the player action sheet: `app/(tabs)/roster.tsx`, `components/roster/RosterItems.tsx`, `components/roster/RosterPlayerSheet.tsx`.
- Lineup starter, bench, IR, and taxi rows: `app/(modals)/lineup.tsx`.
- Trade builder player and pick lists, plus the review and make-legal roster plan editor: `components/trades/TradeAssetColumn.tsx`, `components/trades/TradeRosterPlanEditor.tsx`.
- Waiver claim rows, claim drop selection, and the quick-add drop picker: `components/roster/RosterItems.tsx`, `app/(modals)/claim-player.tsx`, `components/DropPlayerPickerModal.tsx`.
- Player details: `app/player/[id].tsx`, `components/player/PlayerHeader.tsx`.
- League picks: `app/(tabs)/league.tsx`, `components/league/LeaguePicksBank.tsx`.

The shared player row places Yr and the icon in one wrapping group. Disabled asset selection controls remain disabled. Their icons are siblings of the disabled control so browser and native accessibility do not inherit that disabled state. Disabled drops have a separate explanation target over the disabled control.

Lock eligibility and server functions did not change. The starting revision already returns no lineup reservation locks. Lineup indicators therefore read the existing roster reservation resource. Game-start checks and lineup move gates stay the same.

Verification used Node 22.23.2 on the Mac. The private browser build used Node 22.23.3 on the mini.

- Full Vitest: 505 suites passed, 16 skipped. 4,789 tests passed, 48 skipped. Command: `npx vitest run --maxWorkers=2`.
- Focused Vitest: 12 suites and 187 tests passed. Coverage includes rows, roster table and sheet, lineup, claim selection, trade builder and make-legal rows, player details, league picks, formatting, and disabled actions.
- `npm run check:quality`: passed all 13 checks, including lint, application and test typechecks, unused code, generated-source checks, the surface matrix, and design conformance.
- Browser script lint passed. The three browser scripts are registered in knip.json.

The full run exposed an existing rankings test fixture that used the Eastern day while the league used Los Angeles. The fixture now uses the league day. This removes the failure between Eastern and Pacific midnight without changing application logic.

Browser verification used only private project pt4bafableli and ports 637xx. Database HTTP was fenced, scheduled jobs were disabled, Edge network access was limited to loopback, and the separate automation browser rejected outside requests. No production service was contacted.

The before and after directories contain 390 × 844 light and dark agent-browser screenshots for lineup, roster, trade players, trade picks, and league picks. The after directory also contains tap-toast and disabled-drop screenshots. Browser checks exercised a normal icon tap, a long press, and a disabled drop. The reason stayed visible and no destructive action ran.

The roster and trade builder each contained three long reservation sentences before the change. They contain zero afterward, with one icon per reserved asset. The JSON reports record visible text, icon counts, player row sizes, and browser errors.

The application code captured on the mini is commit 5462bb8f. Later commits adjust verification fixtures and evidence only. The mini checkout is disposable. Keep these captures; no repeat data restore is needed to review the change.

Cleanup passed. The private stack is stopped, its containers are gone, the mini config is restored, copied backup files are deleted, and the automation browser is closed. No push, PR, deploy, or CI run was made. Native device interaction and the 48 skipped tests were not run.
