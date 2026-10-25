# Fixtures for live-t19-box-paths and live-t19-box-sides

`live-t19-box-sides.ts` is synthetic and reads nothing here. `live-t19-box-paths.ts` reads the files below, the live-t18
listing and boxes (`live-t18-fixtures/README.md`) for `--case=backfill`, and the boxes already in `live-t17-fixtures/`
or `live-t18-fixtures/`, byte for byte, which are not copied again. The recipe checks every file by SHA-256.

## Boxes (REAL-RAW)

Each box is an NBA CDN final box score copied byte for byte from the task's pinned replay store (gzip of
`https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file name is the SHA-256
of the decompressed body; the recipe checks it and the byte count, and serves the body unchanged once the game has
been played.

- `--case=merge` stores the nine live-t18 games (every pinned Brooklyn and Clippers game from 2025-02-08 through
  2025-02-23), listed in `live-t18-fixtures/README.md`.
- `--case=second-move` stores every pinned Charlotte and Lakers game from 2025-02-04 through 2025-03-02:

| Game | Date (ET) | Teams | Retrieved (UTC) | Bytes | SHA-256 of the body | File in |
| --- | --- | --- | --- | --- | --- | --- |
| 0022400715 | 2025-02-04 | LAL at LAC | 2026-10-21T06:02:37.094Z | 41169 | `1231340181a4a12dd04f5dbaf8067bb9c8b0c3f0189c58b7f60a97abdfa003b5` | live-t17-fixtures |
| 0022400717 | 2025-02-05 | MIL at CHA | 2026-10-21T06:02:38.427Z | 41484 | `ff433fc9922178861ba8c29d4d5ff53f440b26a003658df17e8508095408ef8d` | live-t19-fixtures |
| 0022400731 | 2025-02-06 | GSW at LAL | 2026-10-21T06:02:47.877Z | 40397 | `27434d9137e1e241ba7b3bed79f9d7047523fc464682bb76cbe7511108a4f005` | live-t19-fixtures |
| 0022400734 | 2025-02-07 | SAS at CHA | 2026-10-21T06:02:50.106Z | 41443 | `1bc75a23bf9fcb29b7e9459aad90b3614a598fd3fcd7ee2ad8c4072aa59505e9` | live-t19-fixtures |
| 0022400742 | 2025-02-08 | IND at LAL | 2026-10-21T06:02:55.343Z | 39441 | `a7baf1efaa9145c3034d99b7e5eb33ed44e57be64e452135b56b499c6d838b4b` | live-t17-fixtures |
| 0022400752 | 2025-02-09 | CHA at DET | 2026-10-21T06:03:01.971Z | 41526 | `c7e69a03e103fd0bcb02d7e294589be4bbc597ae49df975ab3a58021cb8c0a92` | live-t19-fixtures |
| 0022400758 | 2025-02-10 | CHA at BKN | 2026-10-21T06:03:06.305Z | 40873 | `2843db41e287034d8c7b08ed5cc15141f9d9de41f8f3886b9313eb8eeab198fd` | live-t17-fixtures |
| 0022400768 | 2025-02-10 | UTA at LAL | 2026-10-21T06:03:12.957Z | 40390 | `ce1298bea4e2ecd4edbab9552e97fbcc7bb58e4f4d10949b2a6d8883c651c2c6` | live-t17-fixtures |
| 0022400770 | 2025-02-12 | CHA at ORL | 2026-10-21T06:03:14.313Z | 42490 | `c923bc7776a8412cf18561f09653e9513ebf4808bbed0260e93e5678e3b0f076` | live-t19-fixtures |
| 0022400781 | 2025-02-12 | LAL at UTA | 2026-10-21T06:03:21.650Z | 40438 | `05a08cf1da56d3d6a05ad99e4108bf02c446689ae45fd755a32ce86944bf4f94` | live-t19-fixtures |
| 0022400524 | 2025-02-19 | CHA at LAL | 2026-10-21T06:00:24.722Z | 42445 | `9d868de9b2e43ce1ae83776c70707492f2da906d9070f5e076d48c324b277fc3` | live-t19-fixtures |
| 0022400794 | 2025-02-20 | CHA at DEN | 2026-10-21T06:03:30.531Z | 42507 | `743dfefa294b404c8f8ba861f20a07410e7e857381f05970f70f80f10d606923` | live-t19-fixtures |
| 0022400796 | 2025-02-20 | LAL at POR | 2026-10-21T06:03:32.047Z | 41304 | `730b9d330b70b714aabaeeb16d69c4591333c6fa44cc92c6997211a5aa3c19af` | live-t19-fixtures |
| 0022400808 | 2025-02-22 | LAL at DEN | 2026-10-21T06:03:40.017Z | 41154 | `233e6bb8d936d02dfdc9c762bb84057445ed03833e9b1033c62260a497abe0c0` | live-t19-fixtures |
| 0022400810 | 2025-02-22 | CHA at POR | 2026-10-21T06:03:41.313Z | 42458 | `47ca3d041eb67941d6f386f75a4b51c5a5b81e2043e1efd40d21d97eb0913302` | live-t19-fixtures |
| 0022400828 | 2025-02-24 | CHA at SAC | 2026-10-21T06:03:53.712Z | 40250 | `c30938f5ba3887b0b85db983e58bde6fcead476fcb7c0880b3573c91786522cf` | live-t19-fixtures |
| 0022400834 | 2025-02-25 | CHA at GSW | 2026-10-21T06:03:57.853Z | 41607 | `0bf855cfc2f8a8ea451b0c16fb0784c2d5e43555d78d3f27176cbd1d49f927e5` | live-t19-fixtures |
| 0022400835 | 2025-02-25 | DAL at LAL | 2026-10-21T06:03:58.307Z | 41184 | `3ee2efe1ac9a06ed29f9d16aef266d69f2439bd1be393f8a1bea4102d3252974` | live-t19-fixtures |
| 0022400847 | 2025-02-27 | CHA at DAL | 2026-10-21T06:04:06.372Z | 42911 | `6ed58dc55c1c40024bef16a03d255c34fbf4a0373e9e6df60f0a1c0ac859a362` | live-t19-fixtures |
| 0022400849 | 2025-02-27 | MIN at LAL | 2026-10-21T06:04:08.178Z | 41354 | `23edd1268d057bf5f32e1ccd21111b2f4869512651a67f2720e88ffd3529c0e0` | live-t19-fixtures |
| 0022400859 | 2025-02-28 | LAC at LAL | 2026-10-21T06:04:15.479Z | 41379 | `4643e9a354f826ce7d156981eb612c3e39600d4812ac72da5b25c3aef36b3704` | live-t19-fixtures |
| 0022400860 | 2025-03-01 | WAS at CHA | 2026-10-21T06:04:15.664Z | 42773 | `4bf3762c046eb898084ad2b57854a518e5453f52ecddefaa3bf3969065c38cee` | live-t19-fixtures |
| 0022400874 | 2025-03-02 | LAC at LAL | 2026-10-21T06:04:25.695Z | 41348 | `b35bec2aac1f18e9836cac8f7ddce825ecc33480f2a8976d5379545cf852fd3a` | live-t19-fixtures |

Mark Williams (NBA 1631109) is in the Lakers' box of 2025-02-08 (INACTIVE_TRADE) and in every Charlotte box from
2025-02-09; Dalton Knecht (NBA 1642261) is in Charlotte's box of 2025-02-07 (INACTIVE_TRADE) and in every Lakers box
from 2025-02-10. Their first real line on the other team, and every later one, is listed in the recipe's output.

## Listings (REAL-DERIVED, with constructed omissions)

`listing-<scenario>.json.gz` is the gzip of one JSON document. `derive.py` writes both from the pinned store, which
it only reads: `python3 -I derive.py <shared/sim2/replay> <out> live-t17-fixtures live-t18-fixtures`. Each document
lists its constructed rows under `constructed`; the recipe checks the SHA-256 of the decompressed document.

| Scenario | SHA-256 of the document | Refreshes (06:00 ET, daily) | Athletes listed |
| --- | --- | --- | --- |
| merge | `e9cd5fbde11d60eb2da9a8b51bfc7cd26aa6105adafdc3fb2690217cfb55a241` | 2025-02-08 to 02-23 (16) | 542 to 554 |
| second-move | `d8702dbb26038f0af639ef89aacf0b7b37d320f1c9de078a8c91bc4117e364c2` | 2025-02-04 to 03-02 (27) | 539 to 555 |

- **Sources:** all 902 pinned 2024-25 regular-season NBA boxes dated up to 2025-03-02, plus their 902 ESPN game summaries.
  - Every body was checked against the store's hash.
  - Store manifest SHA-256: `de4ce76f3d36e69baa4519974e224d625e3f5333fa0625014e406ae793e8345d`.
  - games.json SHA-256: `45e358a5f18a86daa740aa5b5cdbdee709859dae23bc183cce2ed0829be079f1`.
  - Digest of the 1,804 key and hash lines read: `1701ccbad8f2c2747404392d7e90ac86d14c21eaf008ac2fbe3b351e21515531`.
- **Identity, roster pages, injuries and the player index:** derived exactly as in `live-t18-fixtures/README.md`.
  - 557 of 572 people are linked: 556 by name, 1 by jersey; 28 ESPN entries stay unmatched or ambiguous.
  - Every one of the 30 pages is non-empty on every refresh.
  - A refresh on date D uses the boxes dated on or before D, so a team's box of D already counts on D.
- **Constructed, merge:** Ben Simmons (ESPN 3907387, NBA 1627732) is off every page from 2025-02-10 through 02-23.
  ESPN names him "Benjamin Simmons" on his page, in the injuries feed and in the player index, a name whose import
  key differs from the box's "Ben Simmons". The player index leaves him out before 2025-02-13. So his real 2025-02-12
  Clippers box creates a row of its own, and the 02-13 sync-players merges the ESPN row into it.
- **Constructed, second-move:** Williams (ESPN 4701232) and Knecht (ESPN 4897943) are off every page from 2025-02-07
  through 03-02 (the trade, its rescission, the All-Star break and the two weeks after), so their real boxes are the
  only evidence of both moves. Charlotte and the Lakers play on the same dates from 2025-02-10 through 02-26, so a
  held wrong team still has a game until 2025-02-28 (Lakers only), 03-01 (Charlotte only) and 03-02 (Lakers only).

Teams by refresh (a dash is a constructed omission; Out is the injuries feed):

| Scenario | Refresh | Subject | Others |
| --- | --- | --- | --- |
| merge | 2025-02-08, 02-09 | Simmons BKN | Harden LAC, Zubac LAC, Claxton BKN |
| merge | 2025-02-10 to 02-23 | Simmons - | Harden LAC, Zubac LAC, Claxton BKN |
| second-move | 2025-02-04 to 02-06 | Williams CHA, Knecht LAL | Ball CHA Out, Reaves LAL |
| second-move | 2025-02-07 to 03-02 | Williams -, Knecht - | Ball CHA (Out on 02-09, 02-12 to 02-18, 02-20, 02-21, 02-25 to 02-28), Reaves LAL (Out on 03-02) |

## Expected matchup points

Member A owns Simmons and Harden (merge) or Williams and Reaves (second-move); member B owns Zubac and Claxton or
Knecht and Ball; each has two UTIL slots. The scoring is that of `live-t18-fixtures/README.md`. The recipe computes
each week's expected points from the lineups the product's optimizer leaves, applied to the pinned lines, and requires
sync-scores to report exactly those totals with every week finalized. Whether a subject is started on a real game day
of his team is measured separately (the availability check in the recipe), so a release rule that benches him shows
up there, not as a points mismatch.
