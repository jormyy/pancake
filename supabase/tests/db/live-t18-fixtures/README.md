# Fixtures for live-t18-box-transfer-lineups

## Boxes (REAL-RAW)

The stored games are every pinned 2024-25 game of Brooklyn and the Clippers from 2025-02-08 through 2025-02-23. Each
box is an NBA CDN final box score copied byte for byte from the task's pinned replay store (gzip of
`https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file name is the SHA-256
of the decompressed body; the recipe checks it and the byte count, and serves the body unchanged once the game has
been played. Three boxes are already in `live-t17-fixtures/`, byte for byte, and are read from there.

| Game | Date (ET) | Teams | Retrieved (UTC) | Bytes | SHA-256 of the body | File in |
| --- | --- | --- | --- | --- | --- | --- |
| 0022400751 | 2025-02-08 | UTA at LAC | 2026-10-21T06:03:01.202Z | 40461 | `b347b97baf3536d15e46c1e313a7e16260092a3040a9d2f9664f6e69a81f3df0` | live-t18-fixtures |
| 0022400758 | 2025-02-10 | CHA at BKN | 2026-10-21T06:03:06.305Z | 40873 | `2843db41e287034d8c7b08ed5cc15141f9d9de41f8f3886b9313eb8eeab198fd` | live-t17-fixtures |
| 0022400772 | 2025-02-12 | PHI at BKN | 2026-10-21T06:03:15.578Z | 39593 | `b0aa7c529ae6ef51c2438729494911dafddf3c2cc799a62a54a6aa572b689588` | live-t18-fixtures |
| 0022400783 | 2025-02-12 | MEM at LAC | 2026-10-21T06:03:22.937Z | 41417 | `bd9d2c4e674ea8c89e02c5ea771640871e51e70953f4b659a644e01008cbd386` | live-t17-fixtures |
| 0022401004 | 2025-02-13 | LAC at UTA | 2026-10-21T06:05:56.922Z | 40696 | `288c567ab2a7659137c6141815051889034c686a61d309d1a425a61f89c6e5d7` | live-t17-fixtures |
| 0022400791 | 2025-02-20 | CLE at BKN | 2026-10-21T06:03:28.402Z | 39314 | `2587de952e38f9770370357eaeb273253c83879dfe5c6ccc8f698755038e3c4f` | live-t18-fixtures |
| 0022400793 | 2025-02-20 | LAC at MIL | 2026-10-21T06:03:29.765Z | 40187 | `be59eefb6bd5da3d845b5746a1c0fb24c798e87fd577f186726ae50a60f7565c` | live-t18-fixtures |
| 0022400807 | 2025-02-22 | BKN at PHI | 2026-10-21T06:03:39.189Z | 40690 | `ccff2d9c5fd44af23888d3c35cdb8e7f1b994e5d5c8d09915b123f65b58ceab3` | live-t18-fixtures |
| 0022400813 | 2025-02-23 | LAC at IND | 2026-10-21T06:03:43.265Z | 40439 | `83877ee8084f2b883d23b1da9fb374ac62bd41f8764622a98bcee8540c13898a` | live-t18-fixtures |

Ben Simmons is in four of them, all under LAC: 0022400783 (inactive, INACTIVE_RETURN_TO_COMPETITION_RECONDITIONING),
0022401004 (played, 12 points, 43 fantasy points), 0022400793 (25) and 0022400813 (24). No stored Brooklyn box lists him.

## Listing (REAL-DERIVED, with one constructed omission)

`listing.json.gz` is the gzip of one JSON document. `derive.py` writes it from the pinned store, which it only reads:
`python3 -I derive.py <shared/sim2/replay> <out> [live-t17-fixtures]`. The recipe checks the SHA-256 of the
decompressed document, `df9c909594f7d591be75605a1964a75fe418c26a62b1608cdbfb1c1a47963f9b`.

- **Sources:** all 848 pinned 2024-25 regular-season NBA boxes dated up to 2025-02-23, plus their 848 ESPN game summaries.
  - Every body was checked against the store's hash.
  - Store manifest SHA-256: `de4ce76f3d36e69baa4519974e224d625e3f5333fa0625014e406ae793e8345d`.
  - games.json SHA-256: `45e358a5f18a86daa740aa5b5cdbdee709859dae23bc183cce2ed0829be079f1`.
  - Digest of the 1,696 key and hash lines read: `28d6527e5da47ebadf614f27d430c09925e3ca6e692f8c884c96222f47af8ca2`.
- **Identity, roster pages, injuries and the player index:** derived exactly as in `live-t17-fixtures/README.md`.
  - 553 of 567 people are linked: 552 by name, 1 by jersey.
  - Daily refreshes from 2025-02-08 through 2025-02-23 list 541 to 553 athletes, every one of the 30 pages non-empty.
  - A refresh on date D uses the boxes dated on or before D, so a team's box of D already counts on D.
- **Constructed omission:** no pinned input records an ESPN roster page. Ben Simmons (ESPN 3907387, NBA 1627732)
  is off every page from 2025-02-10 through 2025-02-13. His real 2025-02-12 Clippers box (MEM at LAC, a game
  Brooklyn did not play, after ESPN last listed him on BKN on 2025-02-09) is then the only evidence that he left.

Teams by refresh (a dash is the constructed omission; nobody tracked is Out):

| Refresh | Simmons | Harden | Zubac | Claxton |
| --- | --- | --- | --- | --- |
| 2025-02-08, 02-09 | BKN | LAC | LAC | BKN |
| 2025-02-10 to 02-13 | - | LAC | LAC | BKN |
| 2025-02-14 to 02-23 | LAC | LAC | LAC | BKN |

## Expected matchup points

These use the recipe's scoring of points 1, rebounds 1, assists 2, steals 3, blocks 3 and turnovers -1, applied to the
pinned lines. Member A owns Simmons and Harden; member B owns Zubac and Claxton; each has two UTIL slots. The points
are those of the lineups the product's optimizer leaves, so they depend on the release rule:

| Week | A, B with Simmons benched on 02-13 | A, B with Simmons started on 02-13 | A's lines |
| --- | --- | --- | --- |
| 1 (2025-01-27 to 02-02) | 0, 0 | 0, 0 | no stored game |
| 2 (2025-02-03 to 02-09) | 60, 59 | 60, 59 | Harden 60 |
| 3 (2025-02-10 to 02-16) | 115, 142 | 158, 142 | Harden 47 and 68, Simmons 0 (02-12, inactive) and 43 (02-13) |
| 4 (2025-02-17 to 02-23) | 165, 164 | 165, 164 | Harden 46 and 70, Simmons 25 and 24 |
