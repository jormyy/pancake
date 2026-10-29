# Web transfer bytes

Round 1 results remain below. [Round 2](#round-2) records the later changes.

Three changes reduce transfer without changing app queries or visible screens.
The changes repack PNG files, share boot scripts, and reuse verified PWA files.
The common JavaScript bundle stays 1,077,403 raw bytes.

## Result

| Home transfer | Before | After | Saving |
| --- | ---: | ---: | ---: |
| First visit, Brotli-11 | 612,464 | 603,759 | 8,705 (1.42%) |
| Next release, warm HTTP cache | 28,166 | 24,365 | 3,801 (13.49%) |
| Next release, HTTP cache cleared | 593,359 | 44,094 | 549,265 (92.57%) |
| Source PNG files | 237,003 | 177,375 | 59,628 (25.16%) |

All numbers are body bytes. HTTP headers and API response bodies are excluded.

## Method

Builds run on the private Mac mini stack with Node 22 and the existing dependencies.
No production service, deployment, email, push service, or CI job is used.
The build command is `EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 npm run build:web:release`.
Local stack settings replace the public backend settings during export.

Each candidate changes one delivery choice.
Deterministic file counts use one build per candidate.
Compression uses gzip level 9 and Brotli quality 11, separately for each file.
No load-time improvement is claimed.

Phone captures use a fresh automation browser at 390 × 844 pixels in light mode.
Only a generated local login is restored.
First-visit capture ends two seconds after loading panels clear.
It includes static background downloads and PWA installation during that interval.
The local server serves Brotli-11 and implements ETags and the cache policies below.

Repeat captures install a second release with identical app code and new release metadata.
This isolates downloads of unchanged files.
The eviction test clears HTTP cache while keeping service-worker Cache Storage.
Changed application chunks still require a download on a real release.
The actual baseline-to-final home upgrade downloads 296,216 Brotli bytes.
Its changed common chunk is downloaded once; subsequent unchanged releases use the smaller repeat totals.

The after build retains the before build's assets.
Intermediate experiments are not predecessors of the final build.
An export without measurement hooks matches the instrumented export byte for byte.
Module attribution also matches between two independent parsers.

The supplied production bundle is 1,056,043 raw bytes.
The local baseline is 1,077,403 bytes.
These artifacts differ, so all before/after gains compare local artifacts only.

## Measured phone routes

First-visit cells show `raw / gzip-9 / Brotli-11`.
Repeat cells show actual Brotli body downloads with a warm HTTP cache.
Every listed route also passes an offline reload.

| Route | First visit before | First visit after | Repeat before | Repeat after |
| --- | ---: | ---: | ---: | ---: |
| home | 2,406,725 / 749,608 / 612,464 | 2,382,139 / 738,970 / 603,759 | 28,166 | 24,365 |
| matchup | 2,412,303 / 751,848 / 614,378 | 2,387,717 / 741,176 / 605,632 | 28,166 | 24,365 |
| roster | 2,446,372 / 762,492 / 623,692 | 2,421,786 / 751,854 / 614,974 | 28,166 | 24,365 |
| players | 2,494,370 / 777,744 / 636,959 | 2,469,784 / 767,106 / 628,221 | 28,166 | 24,365 |
| trades | 2,455,122 / 765,782 / 626,540 | 2,430,536 / 755,144 / 617,821 | 28,166 | 24,365 |
| league | 2,514,199 / 783,437 / 640,635 | 2,489,613 / 772,799 / 631,896 | 28,166 | 24,365 |
| draft-room | 2,398,500 / 740,761 / 603,652 | 2,375,179 / 731,450 / 596,238 | 56,334 | 24,365 |
| player | 2,406,030 / 741,947 / 604,556 | 2,382,709 / 732,534 / 597,122 | 28,166 | 24,365 |
| sign-in | 2,418,109 / 751,169 / 613,555 | 2,393,523 / 740,533 / 604,852 | 28,166 | 24,365 |
| sign-up | 2,422,036 / 752,062 / 614,284 | 2,397,450 / 741,406 / 605,564 | 28,166 | 24,365 |

The draft room holds updates while open.
Its repeat measurement leaves the room, activates the release, and returns.
This preserves the existing update guard.

## HTML and declared dependencies

The baseline home page contains 57,998 bytes of inline CSS and 17,342 bytes of inline JavaScript.
Most CSS comes from React Native styles, the boot shell, theme rules, and font declarations.
The pages do not contain a large serialized league payload.

Shared boot scripts now use content-addressed files under `/assets/document/`.
Their tags keep the original execution order.
The hydration marker and all CSS remain inline.
The shared files join the existing integrity manifest and mandatory PWA precache.

The table covers every public export route, including built-in pages.
It counts HTML and declared scripts, styles, fonts, and images once each.
These static totals exclude later browser prefetches and the separate service-worker download.
The phone table above includes observed runtime downloads.

| Route | HTML before | HTML after | Declared total before, raw/gzip/br | Declared total after, raw/gzip/br |
| --- | ---: | ---: | ---: | ---: |
| `/+not-found` | 89,592 | 73,255 | 2,237,873 / 687,318 / 557,099 | 2,229,796 / 684,778 / 555,404 |
| `/_sitemap` | 85,538 | 69,201 | 2,232,884 / 685,717 / 555,846 | 2,224,807 / 683,243 / 554,168 |
| `/bracket` | 88,448 | 72,111 | 2,252,477 / 692,505 / 561,644 | 2,244,400 / 689,974 / 560,011 |
| `/change-password` | 92,033 | 75,696 | 2,245,216 / 689,233 / 558,632 | 2,237,139 / 686,683 / 556,998 |
| `/claim-player` | 88,559 | 72,222 | 2,259,139 / 693,803 / 562,819 | 2,251,062 / 691,278 / 561,137 |
| `/commissioner-settings` | 88,700 | 72,363 | 2,300,463 / 707,463 / 573,981 | 2,292,386 / 704,933 / 572,337 |
| `/create-league` | 91,424 | 75,087 | 2,247,716 / 690,298 / 559,600 | 2,239,639 / 687,752 / 558,023 |
| `/draft-room` | 87,258 | 70,921 | 2,237,558 / 686,922 / 556,819 | 2,229,481 / 684,430 / 555,146 |
| `/draft` | 89,225 | 72,888 | 2,238,653 / 687,758 / 557,531 | 2,230,576 / 685,224 / 555,819 |
| `/dynasty` | 86,535 | 70,198 | 2,234,269 / 686,236 / 556,257 | 2,226,192 / 683,746 / 554,544 |
| `/` | 86,582 | 70,245 | 2,244,775 / 690,640 / 560,119 | 2,236,698 / 688,151 / 558,489 |
| `/join-league` | 90,678 | 74,341 | 2,244,021 / 689,340 / 558,781 | 2,235,944 / 686,786 / 557,126 |
| `/league` | 86,534 | 70,197 | 2,341,402 / 719,783 / 584,177 | 2,333,325 / 717,294 / 582,513 |
| `/lineup` | 88,467 | 72,130 | 2,269,428 / 697,546 / 565,985 | 2,261,351 / 695,024 / 564,340 |
| `/matchup` | 88,452 | 72,115 | 2,242,460 / 689,130 / 558,691 | 2,234,383 / 686,607 / 557,020 |
| `/notification-settings` | 88,795 | 72,458 | 2,248,765 / 691,136 / 560,381 | 2,240,688 / 688,607 / 558,732 |
| `/player/[id]` | 94,788 | 78,451 | 2,242,134 / 687,172 / 556,952 | 2,234,057 / 684,578 / 555,259 |
| `/players` | 86,584 | 70,247 | 2,321,573 / 714,090 / 580,501 | 2,313,496 / 711,601 / 578,838 |
| `/profile` | 96,469 | 80,132 | 2,262,615 / 693,878 / 562,730 | 2,254,538 / 691,301 / 561,073 |
| `/propose-trade` | 87,542 | 71,205 | 2,263,608 / 695,765 / 564,653 | 2,255,531 / 693,279 / 562,995 |
| `/rookie-draft-room` | 88,194 | 71,857 | 2,278,551 / 700,487 / 568,268 | 2,270,474 / 697,969 / 566,637 |
| `/roster` | 86,534 | 70,197 | 2,273,575 / 698,838 / 567,234 | 2,265,498 / 696,349 / 565,591 |
| `/sign-in` | 97,966 | 81,629 | 2,255,850 / 697,400 / 566,784 | 2,246,508 / 693,583 / 563,822 |
| `/sign-up` | 100,732 | 84,395 | 2,258,621 / 697,610 / 566,955 | 2,249,279 / 693,773 / 563,976 |
| `/team-roster` | 88,810 | 72,473 | 2,247,259 / 691,315 / 560,410 | 2,239,182 / 688,792 / 558,758 |
| `/timeline` | 87,545 | 71,208 | 2,239,431 / 687,827 / 557,598 | 2,231,354 / 685,332 / 555,904 |
| `/trades` | 86,534 | 70,197 | 2,282,325 / 702,128 / 570,082 | 2,274,248 / 699,639 / 568,438 |

## Common bundle composition

The table shows serialized module bytes in the current common chunk.
Retained old chunks are excluded from composition rankings.
Function bytes match the recorded Metro module before attribution.
These twenty modules are unchanged by the accepted delivery changes.

| Module | Before | After |
| --- | ---: | ---: |
| `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js` | 57,786 | 57,786 |
| `node_modules/@supabase/storage-js/dist/index.mjs` | 21,785 | 21,785 |
| `components/MatchupRow.tsx` | 21,701 | 21,701 |
| `constants/tokens.ts` | 21,685 | 21,685 |
| `components/roster/RosterItems.tsx` | 21,157 | 21,157 |
| `components/navigation/WebTabShell.tsx` | 19,985 | 19,985 |
| `constants/boot-shell.ts` | 18,454 | 18,454 |
| `components/trades/MultiTeamTradeBuilder.tsx` | 15,690 | 15,690 |
| `components/trades/TradeCard.tsx` | 15,193 | 15,193 |
| `node_modules/@supabase/postgrest-js/dist/index.mjs` | 15,075 | 15,075 |
| `app/(modals)/draft-room.tsx` | 13,930 | 13,930 |
| `components/league/draft-room/AuctionLivePanel.tsx` | 13,679 | 13,679 |
| `lib/draft.ts` | 13,127 | 13,127 |
| `node_modules/@supabase/realtime-js/dist/module/RealtimeClient.js` | 12,710 | 12,710 |
| `node_modules/@supabase/realtime-js/dist/module/RealtimeChannel.js` | 11,867 | 11,867 |
| `lib/trades.ts` | 11,446 | 11,446 |
| `node_modules/tslib/tslib.es6.mjs` | 11,360 | 11,360 |
| `components/trades/TradeAssetColumn.tsx` | 11,206 | 11,206 |
| `node_modules/tslib/tslib.js` | 11,084 | 11,084 |
| `components/player/GameLogTable.tsx` | 10,241 | 10,241 |

React and React DOM also occupy the separate bootstrap entry bundle.
That entry remains 971,154 raw bytes, 265,525 gzip bytes, and 212,617 Brotli bytes.
Route splitting is already enabled for web exports.
The tested additional split fails the retained-release integrity gate, as recorded below.

## Compression verdict

| Common bundle | Raw | gzip-9 | Brotli-11 |
| --- | ---: | ---: | ---: |
| Local before | 1,077,403 | 316,704 | 245,043 |
| Local after | 1,077,403 | 316,704 | 245,294 |

On the final local common bundle, Brotli-11 saves 71,410 bytes (22.55%) against gzip-9.
The raw and gzip sizes stay unchanged.
The Brotli size changes slightly when image content hashes change.

The supplied production responses are 311,321 gzip bytes and 308,276 Brotli bytes.
That is a 3,045-byte gain, or 0.98%.
The supplied gzip-9 result is 307,938 bytes.
Thus the current production Brotli response is 338 bytes larger than gzip-9.

Brotli-11 shows useful compression headroom on the local artifact.
Serving a shipped `.br` file cannot be verified without a deployment.
No sidecar files are shipped, and no Vercel endpoint is contacted.
The local compression result is not a claim about Vercel's serving behavior.

## Images and fonts

PNG compression changes only the compressed image stream and chunk packing.
Every decoded stream matches its original byte for byte.
Dimensions and image format stay unchanged.
The boot logo remains 128 × 128 pixels.
PWA icons retain their 192- and 512-pixel sizes.

| PNG | Before | After | Saving |
| --- | ---: | ---: | ---: |
| `public/boot-logo.png` | 7,667 | 6,705 | 962 |
| `public/apple-touch-icon.png` | 9,758 | 8,083 | 1,675 |
| `public/pwa-192.png` | 10,596 | 8,744 | 1,852 |
| `public/pwa-512.png` | 32,822 | 24,326 | 8,496 |
| `public/pwa-512-maskable.png` | 32,822 | 24,326 | 8,496 |
| `assets/images/icon.png` | 79,823 | 53,679 | 26,144 |
| `assets/images/favicon.png` | 3,443 | 3,112 | 331 |
| `assets/images/pancake_logo.png` | 8,901 | 7,636 | 1,265 |
| `assets/images/pancake_logo@2x.png` | 19,856 | 16,296 | 3,560 |
| `assets/images/pancake_logo@3x.png` | 31,315 | 24,468 | 6,847 |

The four loaded fonts already use WOFF2.
The icon font is already subsetted.
No font replacement or glyph removal is kept.

| Font | Raw bytes, unchanged |
| --- | ---: |
| `MaterialIcons` | 3,036 |
| `Outfit_500Medium` | 19,664 |
| `Outfit_600SemiBold` | 20,684 |
| `Outfit_700Bold` | 20,660 |

Total font delivery is 64,044 raw bytes.

## PWA cache and headers

| Mandatory precache | Before | After |
| --- | ---: | ---: |
| URL count | 15 | 17 |
| Raw bodies | 2,247,147 | 2,239,070 |
| gzip-9 bodies | 692,050 | 689,560 |
| Brotli-11 bodies | 561,274 | 559,644 |
| Worker, raw | 36,035 | 38,980 |
| Worker, Brotli-11 | 9,045 | 9,611 |

The worker now checks the newest eight prior asset caches before fetching required boot files.
It accepts only public responses with the current file's SHA-256 hash.
Changed, private, HTML, and legacy-cache responses still require a safe fetch.
Old cached responses remain unchanged.
All required responses must pass before activation.

The worker grows because its code and retained-file manifest grow.
The measured first-visit and repeat totals include that cost.

| Resource | Repository policy | Private server response |
| --- | --- | --- |
| `/_expo/static/**`, `/assets/**` | `public, max-age=31536000, immutable` | Same |
| HTML | No explicit override | `public, max-age=0, must-revalidate`, ETag |
| Hashed manifest | Covered by `/assets/**` | Immutable |
| Root manifest | No explicit override | `public, max-age=0, must-revalidate`, ETag |
| `sw.js` | No explicit override | `public, max-age=0, must-revalidate`, ETag |
| `release-provenance.json` | No explicit override | `public, max-age=0, must-revalidate`, ETag |
| `release-compatibility.json` | No explicit override | `public, max-age=0, must-revalidate`, ETag |

No header change is kept.
Production metadata headers are not probed because production access is forbidden.

## Rejected changes

| Candidate | Measured result | Decision |
| --- | --- | --- |
| External shared CSS and scripts | HTML falls by 72,660 raw bytes; some first visits grow by up to 255 Brotli bytes | Keep scripts only |
| Resolve the core package to source modules | Home dependencies save 70 raw bytes; worker grows by 4,588 raw bytes and 1,248 Brotli bytes | Reject the total transfer increase |
| Remove the eager player-page import | An existing `players` chunk changes from 87,643 to 87,712 bytes at the same immutable URL | Reject; retained-release integrity fails |
| Lazy draft fallback | Home dependencies save 50,354 raw and 11,597 Brotli bytes; the draft room adds 1,988 Brotli bytes | Reject the draft-room regression |
| Three JavaScript minifier passes | App dependencies save about 3,145 raw bytes; complete cold transfer grows by 824 raw and 29 Brotli bytes | Reject; manifest growth cancels the gain |
| Ship Brotli-11 sidecars | Local common bundle saves 71,410 bytes against gzip-9; serving behavior is unverified | Do not ship without a serving test |

## Verification

All eight required phone screenshots match their baseline PNG files byte for byte.
The screenshots show rendered content at 390 pixels, without a visual change.
Home, matchup, roster, players, trades, league, draft room, and player page pass offline reloads.
Sign-in and sign-up also pass the same checks.

Release provenance checks validate every final output hash.
All ten retained files match the before build byte for byte.
The required boot-cache regression fails before the fix and passes after it.
Private and changed prior-cache responses remain rejected.

The full Vitest run records 4,645 passes and 48 skips across 506 files.
The quality command includes lint, application types, test types, E2E types, core checks, and repository conformance checks.
The final quality command passes all its checks.
The fixture test copies the new build helper into isolated exports.
No dependency is added.
The private stack is stopped, and its data copies and generated login files are removed.
No automation browser remains open.

## Reproduction

Use the private mini environment and port block supplied with this task.
Never substitute production backend settings.

```sh
node scripts/bytes-build.mjs baseline
node scripts/bytes-build.mjs final baseline
node scripts/bytes-browser.mjs baseline
node scripts/bytes-browser.mjs final
PANCAKE_BYTES_ROUTES=home PANCAKE_BYTES_CLEAR_HTTP=1 node scripts/bytes-browser.mjs final
PANCAKE_BYTES_TRACE=0 node scripts/bytes-build.mjs final-plain baseline
```

Run the before build from the unchanged app source.
Run the after build from the accepted app source.
The byte commands require the private mini environment and refuse a local workstation build.
The report's byte manifests and screenshots stay outside the repository.

## Round 2

Round 2 keeps helper deduplication, small inline CSS compression, and lazy draft loading.
Storage and authentication behavior stay unchanged.
No application query or backend code changes.

### Phone transfer

Cells show body bytes as `raw / gzip-9 / Brotli-11`.
Repeat columns show observed Brotli downloads after a metadata-only release with a warm HTTP cache.
The build retains the Round 2 baseline assets.
Intermediate experiments are not release predecessors.
All candidates use the same release identifier during measurement.

| Route | First before | First after | Repeat before | Repeat after |
| --- | ---: | ---: | ---: | ---: |
| home | 2,380,111 / 738,482 / 603,335 | 2,322,692 / 719,605 / 591,924 | 23,936 | 25,126 |
| matchup | 2,385,689 / 740,688 / 605,221 | 2,328,270 / 721,812 / 593,867 | 23,936 | 25,126 |
| roster | 2,419,758 / 751,366 / 614,535 | 2,362,339 / 732,490 / 603,185 | 23,936 | 25,126 |
| players | 2,467,756 / 766,618 / 627,781 | 2,410,337 / 747,741 / 616,436 | 23,936 | 25,126 |
| trades | 2,428,508 / 754,656 / 617,408 | 2,371,089 / 735,783 / 606,036 | 23,936 | 25,126 |
| league | 2,487,585 / 772,311 / 631,470 | 2,430,166 / 753,446 / 620,066 | 23,936 | 25,126 |
| draft-room | 2,373,151 / 730,962 / 595,822 | 2,366,269 / 728,044 / 598,008 | 23,936 | 25,126 |
| player | 2,380,681 / 732,046 / 596,714 | 2,323,262 / 713,166 / 585,354 | 23,936 | 25,126 |
| sign-in | 2,391,495 / 740,045 / 604,467 | 2,334,076 / 721,167 / 593,067 | 23,936 | 25,126 |
| sign-up | 2,395,422 / 740,918 / 605,144 | 2,338,003 / 722,044 / 593,767 | 23,936 | 25,126 |

The draft room first visit grows by 2,186 Brotli bytes.
Home saves 11,411 Brotli bytes, or 1.89%.
The repeat update grows by 1,190 bytes because the worker and release metadata change.
Unchanged application files still come from cache.

| Home repeat scenario | Before | After | Change |
| --- | ---: | ---: | ---: |
| Warm HTTP cache | 23,936 | 25,126 | +1,190 |
| HTTP cache cleared, worker cache kept | 43,665 | 44,855 | +1,190 |

The actual baseline-to-final upgrade downloads 481,827 Brotli bytes once.
It fetches the changed bootstrap, common bundle, and affected chunks.
The repeat columns above measure a later release with unchanged app code.

### Individual keeps

| Change | Home first, before → after | Home repeat, before → after |
| --- | ---: | ---: |
| One web tslib implementation | 603,335 → 602,387 | 23,936 → 24,023 |
| Font and auth CSS compression | 602,387 → 602,199 | 24,023 → 24,009 |
| Lazy draft fallback | 602,199 → 591,924 | 24,009 → 25,126 |

The resolver maps web imports and requires of tslib to its exported ESM file.
Native resolution stays unchanged.
The duplicate module falls from 22,444 to 11,360 raw bytes.
Total common-bundle savings are 11,112 raw bytes for this step.

Font rules fall from 1,056 to 1,036 raw bytes.
The auth layout rules fall from 669 to 536 bytes.
The stylesheet identifier, font URLs, cascade order, and React Native stylesheet remain intact.
The compiler already ships with Expo; no dependency is added.

### Weekly draft model

The browser opens home, enters the draft, leaves through its normal control, and returns home.
The draft adds zero downloads before the split and 13,506 Brotli bytes afterward.
Returning through league adds 28,168 bytes before and 28,123 afterward.
Those league downloads belong to leaving the draft, not to ordinary home visits.

The model assumes one cold home visit and one metadata-only release update per week.
Additional warm home visits reuse the same application files.
It assumes a draft visit in one week out of ten.
This is a stated workload assumption, not measured user frequency.

| Scenario, isolating the draft split | Before | After | Saving |
| --- | ---: | ---: | ---: |
| Home plus release update | 626,208 | 617,050 | 9,158 |
| Same week with a draft visit and return | 654,376 | 658,679 | -4,303 |
| Expected week at 10% draft use | 629,025 | 621,213 | 7,812 |

All three changes save 8,875 bytes per expected week against the Round 2 baseline under this model.
The split breaks even when draft visits occur in 68.03% of these weeks.
Rare draft use stays below that threshold.
For other update rates, saving equals `10,275 − 1,117 × updates − 13,461 × draft_probability` bytes.
A draft-heavy week costs more; the table includes that tradeoff.
The existing auction hold is observed in both direct and navigated draft visits.
Release activation waits until the user leaves the room.

### Current common bundle

| Compression | Before | After | Saving |
| --- | ---: | ---: | ---: |
| raw | 1,077,403 | 1,015,861 | 61,542 |
| gzip | 316,704 | 296,496 | 20,208 |
| br | 245,294 | 232,846 | 12,448 |

The table covers the top twenty modules from each build and excludes retained old chunks.
A dash means the module no longer belongs to this chunk.

| Module | Before rank | Before bytes | After rank | After bytes |
| --- | ---: | ---: | ---: | ---: |
| `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js` | 1 | 57,786 | 1 | 57,791 |
| `node_modules/@supabase/storage-js/dist/index.mjs` | 2 | 21,785 | 2 | 21,785 |
| `components/MatchupRow.tsx` | 3 | 21,701 | 3 | 21,701 |
| `constants/tokens.ts` | 4 | 21,685 | 4 | 21,685 |
| `components/roster/RosterItems.tsx` | 5 | 21,157 | 5 | 21,157 |
| `components/navigation/WebTabShell.tsx` | 6 | 19,985 | 6 | 19,985 |
| `constants/boot-shell.ts` | 7 | 18,454 | 7 | 18,454 |
| `components/trades/MultiTeamTradeBuilder.tsx` | 8 | 15,690 | 8 | 15,690 |
| `components/trades/TradeCard.tsx` | 9 | 15,193 | 9 | 15,193 |
| `node_modules/@supabase/postgrest-js/dist/index.mjs` | 10 | 15,075 | 10 | 15,075 |
| `app/(modals)/draft-room.tsx` | 11 | 13,930 | — | — |
| `components/league/draft-room/AuctionLivePanel.tsx` | 12 | 13,679 | — | — |
| `lib/draft.ts` | 13 | 13,127 | 11 | 13,127 |
| `node_modules/@supabase/realtime-js/dist/module/RealtimeClient.js` | 14 | 12,710 | 12 | 12,710 |
| `node_modules/@supabase/realtime-js/dist/module/RealtimeChannel.js` | 15 | 11,867 | 13 | 11,867 |
| `lib/trades.ts` | 16 | 11,446 | 14 | 11,446 |
| `node_modules/tslib/tslib.es6.mjs` | 17 | 11,360 | 15 | 11,360 |
| `components/trades/TradeAssetColumn.tsx` | 18 | 11,206 | 16 | 11,206 |
| `node_modules/tslib/tslib.js` | 19 | 11,084 | — | — |
| `components/player/GameLogTable.tsx` | 20 | 10,241 | 17 | 10,241 |
| `app/player/[id].tsx` | 21 | 10,215 | 18 | 10,215 |
| `node_modules/@supabase/auth-js/dist/module/lib/webauthn.js` | 22 | 10,198 | 19 | 10,201 |
| `node_modules/@shopify/flash-list/dist/recyclerview/RecyclerViewManager.js` | 23 | 9,609 | 20 | 9,608 |

Small per-module size changes come from generated import references.
The duplicate `tslib.js` module no longer ships in the current common chunk.
The draft screen and its exclusive UI now belong to the draft chunk.

### Rejected options and bootstrap audit

| Candidate | Measured result | Decision |
| --- | --- | --- |
| Remove Storage | The app calls avatar upload and public URL methods; the module is 21,785 raw bytes | Keep the supported client |
| Smaller Auth client | AuthClient aliases GoTrueClient; its 57,786-byte class includes MFA and OAuth methods | No supported smaller entry exists in the installed package |
| Shared theme stylesheet | First HTML plus CSS grows 528–638 Brotli bytes across exported pages | Reject |
| Shared font stylesheet | First HTML plus CSS grows 82–200 Brotli bytes | Reject |
| Shared theme and font stylesheets | First HTML plus CSS grows 702–772 Brotli bytes | Reject |
| Minify theme CSS | HTML shrinks 757 raw bytes but grows 58–129 Brotli bytes | Reject |
| Minify all small unmanaged styles | Some HTML grows by 15 Brotli bytes | Keep only the measured font and auth subset |

The partial stylesheet rows come from compressing every exported page and its added CSS files.
They are rejected before a serving change.
On home, modeled repeat HTML saves 2,099 bytes for shared themes, 97 for fonts, and 2,183 for both.
These are compression estimates; no shared CSS serving change is made.
No theme rule or glyph is removed.

The 971,154-byte baseline bootstrap uses React and React DOM production modules.
Its 663 modules contain no development build.
The React DOM client contributes 168,343 raw bytes; React contributes 7,681.
Locale helpers total 2,389 bytes and contain no bulk locale data.
Four distinct Expo and asset polyfills total 2,237 bytes.
The only app-specific entry is the 4,829-byte generated route context.
No duplicate polyfill implementation is found.

The lazy split changes route references in that context.
The final bootstrap is 971,230 raw, 265,561 gzip, and 212,623 Brotli bytes.
Its six-byte Brotli increase is included in the transfer tables.
The final common bundle saves 63,650 bytes with Brotli-11 versus gzip-9 (21.47%).
No production compression endpoint or deployment is used.

### Round 2 verification

All ten before/after screenshots match byte for byte.
The eight required phone screens show the same rendered content at 390 pixels in light mode.
All ten routes pass an offline reload with cached content.
Offline player statistics render, but its action slot waits for league access to be checked.
The same action placeholder and access notice appear in the baseline.
The draft guard remains active until the room closes.

All four exports pass artifact and provenance validation.
The final export retains 20 files with their recorded hashes.
An export without measurement hooks has the same files and bundle digest.
A final export uses the committed SHA and matches the measured application assets.
Its home check records 591,946 first-visit and 25,092 repeat Brotli bytes.
The small difference from the controlled table comes from release metadata.
Helper deduplication and CSS compaction each have a failing regression test before the fix.
The full Vitest run passes 4,647 tests and skips 48 across 506 files.
The quality command passes lint, all type checks, and repository checks.

The local gateway initially lacks its required bind grant.
The measurement helper now listens only on loopback.
All retained browser results are rerun with the working local gateway.
Draft exit measurements also wait for the destination screen to settle.
The private stack is stopped, and its data volumes, backup copies, and generated login files are removed.
No automation browser remains open.

```sh
PANCAKE_RELEASE_SHA=b1c23d8aafc8558a8feea6f20006c68d5f47e854 node scripts/bytes-build.mjs r2-draft r2-base
PANCAKE_BYTES_WEEK=1 node scripts/bytes-browser.mjs r2-draft
PANCAKE_BYTES_ROUTES=home PANCAKE_BYTES_CLEAR_HTTP=1 node scripts/bytes-browser.mjs r2-draft
```
