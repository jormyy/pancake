Player forecast badges now read `5yr: 3.9` and `3yr: 4.1`. Values keep their existing string representation. Accessibility labels retain `5-year points 3.9` and `3-year points 4.1`.

The presentation change is in `components/player/PlayerHeader.tsx`. A search across app and components found no other badges or row labels rendering these two forecast values. Dynasty ranking rows show a separate calculated value. The `5-Year Points` and `3-Year Points` ranking menu names remain unchanged.

Focused verification uses `tests/components/player/player-detail.test.ts` and `tests/app/dynasty-tools-ui.test.ts`. It covers decimal, integer, and zero values, full accessibility wording, and unchanged ranking menu names. Both application and test typechecks passed. Lint passed for the changed files. The full suite is deferred until before push.

The existing Hashtag browser check now waits for the concise visible text and still checks full accessibility names. `tests/e2e/dynasty-points-header-browser.mjs` is registered in knip.json.

The screenshots show the actual player page at 390 × 844 in light and dark themes. The browser supplies fixture forecast values 3.9 and 4.1 in the local player-view response so both badges are visible. Other data comes from the private restored stack. The browser checks both visible labels, both accessibility names, and the header bounds.

The two example labels shrink from 34 to 16 characters combined.

Verification commands and results:

- `npx vitest run tests/components/player/player-detail.test.ts tests/app/dynasty-tools-ui.test.ts`: 33 passed, zero failed.
- `npm run typecheck && npm run typecheck:tests`: passed.
- ESLint on the changed component, unit test, and browser scripts: passed.
- `node tests/e2e/dynasty-points-header-browser.mjs` on the mini: two captures passed, zero page errors, zero external requests.

The application change is commit 020222f3. The capture script update is commit ce416a74. No full suite, push, PR, deploy, or CI run was performed for this follow-up.

Screenshots: [light](player-header-light.png), [dark](player-header-dark.png).

Cleanup passed. The private stack is stopped, its containers are gone, the mini config is restored, copied backup files are deleted, and the automation browser is closed. Nothing remains for this follow-up. Keep the captures; no repeat restore is needed.
