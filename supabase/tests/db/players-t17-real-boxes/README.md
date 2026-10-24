# Real boxes for players-t17-real-played-last

These are REAL-RAW NBA CDN final box scores, kept byte for byte as pinned in the task's replay store
(gzip of `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file
name is the SHA-256 of the decompressed body; the recipe checks it before serving the body unchanged.
Retrieval times are the store's; the bodies describe games played long before them.

| Game | Retrieved (UTC) | Bytes | SHA-256 of the body |
| --- | --- | --- | --- |
| 0022500859 | 2026-10-20T09:01:00.827Z | 39098 | `a0ee7817fa8bd627308082557bb9fe7687d4d01b234554de3f8778867fd683dc` |
| 0022500874 | 2026-10-20T09:01:10.549Z | 38281 | `35a12278f5af8dbe7bbbca15c29ccba578d1635b8b0c565a6f41e24439373f5b` |
| 0022501186 | 2026-10-20T09:04:43.994Z | 38580 | `3ba1bb719d815d0f1b7e6cb61dbd6b2fb7874154424723b791d7ee7c954fced7` |
| 0022500495 | 2026-10-20T08:57:11.268Z | 40366 | `09465e983fea6909cc88ec0da3c61c3e643ef781fd61b7501f5018f78820bebe` |
| 0022500510 | 2026-10-20T08:57:21.234Z | 39502 | `87a521d0f348ef8ee6eb1380c7656ae0ebf26d9edbe38331e22b40f6f960612f` |
| 0022500528 | 2026-10-20T08:57:32.392Z | 41443 | `ace5ee6a74d16fab06db641bbea18ad24c7fbfbe25033aa9eac7cc07d7bf674a` |
| 0022500714 | 2026-10-20T08:59:29.628Z | 40728 | `57162e31629e00cbab3ab92c935f583e00e61b9f1d027aaa0835a79e54f45701` |
| 0022500727 | 2026-10-20T08:59:37.647Z | 38343 | `d535d0448eb9c698fb8323afe839a06936dc8e9cee1a7ef2684cc2e7275e8456` |
| 0022500806 | 2026-10-20T09:00:26.918Z | 39358 | `aa9e163918b6a83495a8fcbb81e9da52be574f3bf874a4a5271b70d5eaeacd0a` |
| 0022401098 | 2026-10-21T06:07:03.980Z | 43995 | `d26267aae0d46fce2a7a6a3ccf81600d472e39ffdaa07aee0ab3c85a1c39d76e` |
| 0022401115 | 2026-10-21T06:07:15.941Z | 43756 | `92f6268583444bba56cdc3f7937f3112f66af76723876c8d8c2fa7996902bcc8` |
| 0022401130 | 2026-10-21T06:07:27.089Z | 43507 | `02fbe21925ead95d2f7a135987fe0693e26ea2fabe1a723ca8265f65dbf12975` |

What the boxes show, by game date (Eastern). Each player's last listing before the gap shows him playing:

- Dalano Banton, BOS. 2026-02-27 against BKN (0022500859) lists him playing (5:59, 4 points). 2026-03-01
  against PHI (0022500874) does not list him at all; ESPN's game summary for that game (event 401810729,
  pinned in the same store, retrieved 2026-10-20T09:01:11.507Z, SHA-256
  `acba7e80593c738920f9d349d9b39b908af7aaabd744f2788070e3b1b3b191c1`) lists him for BOS with no minutes.
  BOS's boxes keep omitting him for 22 games, through 2026-04-10; 2026-04-12 against ORL (0022501186) lists
  him playing (36:30). The recipe stores the first omitting box only.
- Tony Bradley, IND. 2026-01-04 at ORL (0022500495) lists him playing (7 minutes). 2026-01-06 against CLE
  (0022500510) does not list him. 2026-01-08 at CHA (0022500528) lists him playing.
- Mike Conley, MIN. 2026-02-02 at MEM (0022500714) lists him playing (14:21). 2026-02-04 at TOR (0022500727)
  and MIN's next four boxes, through 2026-02-11, do not list him. 2026-02-20 against DAL (0022500806) lists
  him again, not playing. Bagley's third box (PHI against MIN, 2025-04-05) also lists Conley, playing for MIN
  a season earlier (24:58, 8 points, 4 rebounds, 4 assists; ESPN's summary of that game, event 401705696,
  lists athlete 3195 Mike Conley for MIN with the same line). The recipe stores each third box on a day of its
  own in real date order and starts each player only on his own return box's day, so that row scores on
  Bagley's day, where Conley is not started, and Conley's DNP return scores nothing.
- Marcus Bagley, PHI. 2025-04-01 at NYK (0022401098) lists him playing. 2025-04-03 against MIL
  (0022401115) does not list him. 2025-04-05 against MIN (0022401130) lists him playing.

No other team lists any of them between the omission and the re-listing. They come from the players-t16
census of all 2,460 pinned regular-season boxes (evidence outside the repository).
