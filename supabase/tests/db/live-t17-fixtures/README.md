# Fixtures for live-t17-transfers-scoring

## Boxes (REAL-RAW)

The `boxscore-*.json.gz` files are NBA CDN final box scores, copied byte for byte from the task's pinned replay store
(gzip of `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file name is
the SHA-256 of the decompressed body. The recipe checks that hash and the byte count, and serves the body
unchanged once the game has been played. The retrieval times are the store's; the games were played long before.

| Game | Date (ET) | Teams | Retrieved (UTC) | Bytes | SHA-256 of the body |
| --- | --- | --- | --- | --- | --- |
| 0022400648 | 2025-01-27 | LAL at CHA | 2026-10-21T06:01:51.145Z | 41573 | `4e502e79510ec6d53a7fd5197f2ff7304cfcfab27bd2867d721d69910cfd8b0c` |
| 0022400657 | 2025-01-27 | WAS at DAL | 2026-10-21T06:01:57.094Z | 41689 | `8892d812c8f314df159b3cfa369f90fc50d387a32105fff6321756c62d23a694` |
| 0022400663 | 2025-01-29 | BKN at CHA | 2026-10-21T06:02:01.909Z | 41834 | `e78e20e402876f22bc7324f9f981bf4a2c2000b1416102cee3952645c30964af` |
| 0022400715 | 2025-02-04 | LAL at LAC | 2026-10-21T06:02:37.094Z | 41169 | `1231340181a4a12dd04f5dbaf8067bb9c8b0c3f0189c58b7f60a97abdfa003b5` |
| 0022400712 | 2025-02-04 | DAL at PHI | 2026-10-21T06:02:35.242Z | 39741 | `4d3573ad53ad6ff10e7733aa0f44cdbe2a0def5e1dffc7d584cadbe558b59aed` |
| 0022400720 | 2025-02-05 | WAS at BKN | 2026-10-21T06:02:40.652Z | 41726 | `d22cb43587336bcd7270d3b4f302399811ff287b0902d0c6e2fd950047186dd9` |
| 0022400737 | 2025-02-07 | MIA at BKN | 2026-10-21T06:02:51.720Z | 41440 | `e6a93e9828f731c2e84349eb1043a0b2f163d421052814107569ee205731d80f` |
| 0022400741 | 2025-02-08 | HOU at DAL | 2026-10-21T06:02:54.442Z | 40335 | `0bcc46906c7efb0c36223648bd0c96138213639bd2ec1934ab17295df35832eb` |
| 0022400742 | 2025-02-08 | IND at LAL | 2026-10-21T06:02:55.343Z | 39441 | `a7baf1efaa9145c3034d99b7e5eb33ed44e57be64e452135b56b499c6d838b4b` |
| 0022400758 | 2025-02-10 | CHA at BKN | 2026-10-21T06:03:06.305Z | 40873 | `2843db41e287034d8c7b08ed5cc15141f9d9de41f8f3886b9313eb8eeab198fd` |
| 0022400768 | 2025-02-10 | UTA at LAL | 2026-10-21T06:03:12.957Z | 40390 | `ce1298bea4e2ecd4edbab9552e97fbcc7bb58e4f4d10949b2a6d8883c651c2c6` |
| 0022400762 | 2025-02-10 | SAC at DAL | 2026-10-21T06:03:09.144Z | 38432 | `d6def579946a5f58a04e07b65f4c83f3e89cb2cb6ae17e0bfed89ee8632aea4c` |
| 0022400783 | 2025-02-12 | MEM at LAC | 2026-10-21T06:03:22.937Z | 41417 | `bd9d2c4e674ea8c89e02c5ea771640871e51e70953f4b659a644e01008cbd386` |
| 0022401004 | 2025-02-13 | LAC at UTA | 2026-10-21T06:05:56.922Z | 40696 | `288c567ab2a7659137c6141815051889034c686a61d309d1a425a61f89c6e5d7` |

## Listing (REAL-DERIVED, with two constructed omissions)

`listing.json.gz` is the gzip of one JSON document. `derive.py` writes it from the pinned store, which it only reads:
`python3 -I derive.py <shared/sim2/replay> <out>`. The recipe checks the SHA-256 of the decompressed document,
`5398c598596c0d9af64076070d6b4eb44428f945d541bb69eb8e0dc0d5e0d8d9`.

- **Sources:** all 814 pinned 2024-25 regular-season NBA boxes dated up to 2025-02-13, plus their 814 ESPN game summaries.
  - Every body was checked against the store's hash.
  - Store manifest SHA-256: `de4ce76f3d36e69baa4519974e224d625e3f5333fa0625014e406ae793e8345d`.
  - games.json SHA-256: `45e358a5f18a86daa740aa5b5cdbdee709859dae23bc183cce2ed0829be079f1`.
  - Digest of the 1,628 key and hash lines read: `d35f8b57fdf88321a7cdbbd048e5718aac7bb26b7f79b060e3bf6e0792bd6a06`.
- **Identity:** each ESPN athlete in a summary is matched to the NBA person on the same team in the same game.
  - The match is by normalized name, or by jersey when the name fails and neither side is already claimed.
  - 545 of 558 people are linked: 544 by name, 1 by jersey.
  - 9 ESPN athletes stay unmatched. ESPN summaries list only dressed players, so a player who never dressed has no ESPN id.
- **ESPN roster pages for a refresh on date D:**
  - Each linked athlete is on the team of the latest box dated on or before D that lists him, in any status.
  - A team's box is its game-day roster report, so a trade shows up in the first box after it.
  - Names and positions are ESPN's.
  - All 30 pages are non-empty, with 538 to 544 athletes in total.
- **Injuries feed:** Out when that latest box gives INACTIVE_INJURY or DND_INJURY.
  - ESPN summary injuries in the store describe the retrieval date, not the game, so they are not used.
- **NBA player index for D:** every person in a box dated on or before D, with the box's first and family names.
- **Constructed omissions:** no pinned input records an ESPN roster page.
  - Austin Reaves is omitted from LAL's page from 2025-02-05 to 2025-02-13, while LAL's boxes keep listing him playing.
  - Ben Simmons is omitted from BKN's page on 2025-02-10, between BKN's last box listing him (2025-02-07,
    INACTIVE_NOT_WITH_TEAM) and LAC's first (2025-02-12).

Teams by refresh (Out marks the injuries feed; a dash is a constructed omission):

| Refresh | Davis | Doncic | Simmons | Reaves | James | Irving |
| --- | --- | --- | --- | --- | --- | --- |
| 2025-01-27 | LAL | DAL Out | BKN Out | LAL | LAL | DAL |
| 2025-01-29 | LAL | DAL Out | BKN | LAL | LAL | DAL |
| 2025-02-04 | DAL Out | LAL Out | BKN Out | LAL | LAL | DAL |
| 2025-02-05 | DAL Out | LAL Out | BKN | - | LAL | DAL |
| 2025-02-07 | DAL Out | LAL Out | BKN | - | LAL | DAL |
| 2025-02-08 | DAL | LAL Out | BKN | - | LAL Out | DAL |
| 2025-02-10 | DAL Out | LAL | - | - | LAL | DAL |
| 2025-02-12 | DAL Out | LAL | LAC | - | LAL | DAL |
| 2025-02-13 | DAL Out | LAL | LAC | - | LAL | DAL Out |

## Expected matchup points

These use the recipe's scoring of points 1, rebounds 1, assists 2, steals 3, blocks 3 and turnovers -1, applied to the
pinned lines. Member A owns Davis, Doncic, Simmons and Reaves; member B owns James and Irving. Every owned player is
in a UTIL slot every day.

| Week | A | B | A's scoring lines |
| --- | --- | --- | --- |
| 1 (2025-01-27 to 02-02) | 137 | 67 | Davis LAL 71, Reaves 42, Simmons BKN 24 |
| 2 (2025-02-03 to 02-09) | 203 | 150 | Reaves 44 and 71 (held from 02-05), Simmons BKN 24, Davis DAL 64 |
| 3 (2025-02-10 to 02-16) | 114 | 104 | Reaves 45 (held), Doncic LAL 26, Simmons LAC 43 |
