# League History handoff

League → History lists completed Pancake seasons, newest first.
A season opens its final places, playoff finishes, regular-season records, and points.
Activity keeps its existing tab and route.

## Data shape

`view_league_history(p_league_id, p_member_id, p_params)` returns `{ context, seasons }`.
`view_league` calls it when `p_params.tab` is `seasons`.
The screen uses the existing League cache and refresh path.

Each season contains `id`, `year`, `champion`, `standings`, and `stats`.
The champion contains `memberId` and `teamName`.
Each standing contains `memberId`, `teamName`, `finalRank`, `regularSeasonRank`, `wins`, `losses`, `ties`, `pointsFor`, `pointsAgainst`, and `playoffResult`.
Stats contain `teams`, regular-season `games`, and regular-season `pointsFor`.
The year is the season's ending year.

A completed season has a finalized, non-void playoff final with a winner.
The query reads Pancake's season, standings, member, and matchup tables.
It does not read imported provider history.
It uses each team's latest saved cumulative regular-season standings.
Final places sort the champion, runner-up, then later playoff exits first.
Regular-season rank orders teams that exit in the same round.
Current members must authenticate as the supplied member.
Anonymous and non-member reads fail.

## Changed files

- `app/(tabs)/league.tsx`
- `components/league/LeagueHistory.tsx`
- `components/ui/Badge.tsx`
- `hooks/use-league-screen-state.ts`
- `hooks/use-league-tab-resources.ts`
- `lib/league-history.ts`
- `lib/league/tabs.ts`
- `package.json`
- `supabase/migrations/20261214009800_league_history.sql`
- `supabase/sql/functions/by-name/public/view_league_history.sql`
- `supabase/sql/functions/by-name/public/view_league.sql`
- `supabase/sql/function-catalog.json`
- `types/database.ts`
- `tests/app/league-history.test.ts`
- `tests/app/league-activity-refresh.test.ts`
- `tests/db/league-history.sql`
- `tests/db/seed-league-history.mjs`
- `tests/db/league-history.md`
- `tests/e2e/db-security-catalog-attestations.json`
- `tests/e2e/release-history-attestations.json`

The badge fix removes a text style from the outer View.
It fixes an inherited TypeScript error without changing the intended text style.
The Activity test adds the new component mock.

## Verification

Use a private local Supabase stack with a unique project ID and unused ports.
Set `SUPABASE_DB_URL` to its loopback database URL.
Set `PANCAKE_TEST_DB_PORT` to its database port for the attestation generator.

Run `npm run test:db:league-history` for database behavior.
All 15 checks pass.
They cover two completed seasons, an empty league, final ranks, champions, records, totals, access, and large-bracket round labels.
A deliberate wrong-champion mutation fails the champion assertion.
A deliberate early-round mislabel also fails the large-bracket assertion.
Both mutations are restored before the final checks.

The browser fixture uses `npm run seed:db:league-history` on that private stack.
It creates a local account and prints its email, league, and member IDs.
Its local-only password is `History-only-123!`.
The fixture clears its own pending broadcast batch before commit.
Without this step, the existing 4096-byte hint limit rejects the large setup transaction.
This setup issue is separate from the read feature; production broadcast code is unchanged.

The catalog, generated types, and both attestations come from a fresh private stack through migration 20261214009800.
Use these commands before stopping the stack:

```sh
npm run generate:database-types
npm run generate:db-function-catalog
node scripts/regenerate-release-history-attestations.mjs
npm run check:database-types
npm run check:db-function-sources
npm run check:db-function-catalog
```

Focused Vitest files cover unmapped UI, cache, routing, SQL sources, release metadata, and badge styling:

```sh
npx vitest run tests/app/league-history.test.ts tests/app/league-activity-refresh.test.ts tests/lib/league-tab.test.ts tests/hooks/league-resource-identity.test.ts tests/hooks/league-section-entry.test.ts tests/hooks/league-draft-shared-read.test.ts tests/lib/cache/screen-cache.test.ts tests/db-function-source-parity.test.ts tests/release-history-attestations.test.ts tests/db-security-catalog-contract.test.ts tests/ui/design-system.test.ts tests/ui-polish-backup.test.ts
npx vitest run tests/e2e-attestation-head.test.ts tests/e2e-database-type-generator.test.ts tests/ios-sim/stack.test.ts tests/soak-shards.test.ts
```

These runs pass 1176 tests across 17 files.
The core enum check passes one additional test.
`deno test --no-lock supabase/functions/verify/database.test.ts` passes three tests.
`npm run check:quality` passes after removing this run's generated temporary Edge entrypoint.
The selector also requests full suites because package.json changes.
The lane's explicit full-suite ban takes precedence; `npm test` remains for integration.

## Browser evidence

Evidence lives in `~/Documents/pancake-overhaul/evidence/history/`.
`seasons-390.png` and `seasons-375.png` show both seasons.
`standings-390.png` and `standings-375.png` show all five final places and season totals.
`older-season-375.png` shows the older season's different champion.
Snapshots preserve the visible rows and totals.
Document width equals the viewport at both 390 and 375 pixels.
The horizontal League tab strip remains intentionally scrollable.
Browser errors are empty; the console has existing React Native development warnings.

The browser uses the real local app, local API, and generated account.
It signs in through the form and opens History through League navigation.
Screenshots are reviewed visually.
Physical iPhone, Safari, standalone PWA behavior, and the full test suite remain unverified.

No commit, push, deployment, or production access occurs.
The local stack and browser close, and `supabase/config.toml` returns to its original contents.
Do not redo UI implementation or the completed browser journey.
The integration lane owns full-suite verification and the final commit.
