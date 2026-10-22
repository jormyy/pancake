# Real boxes for players-t16-real-omission

These are REAL-RAW NBA CDN final box scores, kept byte for byte as pinned in the task's replay store
(gzip of `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file
name is the SHA-256 of the decompressed body; the recipe checks it before serving the body unchanged.
Retrieval times are the store's; the bodies describe games played long before them.

| Game | Retrieved (UTC) | Bytes | SHA-256 of the body |
| --- | --- | --- | --- |
| 0022500810 | 2026-10-20T09:00:29.384Z | 40280 | `29ce1031024bfef1bccc1280ce62e5098d18f23d9ac184b9757a1b07309e9124` |
| 0022500826 | 2026-10-20T09:00:39.270Z | 39429 | `103d4f61f7fbdb11c068d99567b078749ce4662ee37add45954d1e92455d2f03` |
| 0022500841 | 2026-10-20T09:00:49.503Z | 38334 | `f08c7be3a318dc0775e88e390376fb6b68d64230af1fc7d9777a120058853eb2` |
| 0022400849 | 2026-10-21T06:04:08.178Z | 41354 | `23edd1268d057bf5f32e1ccd21111b2f4869512651a67f2720e88ffd3529c0e0` |
| 0022400858 | 2026-10-21T06:04:14.172Z | 40526 | `7deab2df521163f2b7f17ff399f26b0da63b70bd8d5dc9ca252f46d5787db141` |
| 0022400873 | 2026-10-21T06:04:25.427Z | 40951 | `57c4fcaa544330cbd0cb69cb9437cee75fa49d0e6312d5016abeda66df3232fa` |
| 0022500176 | 2026-10-20T08:53:45.015Z | 41364 | `3ff81694bd74648cd86c75acb693ac0c91cdd1a15b8333b52398028ac102d947` |
| 0022500034 | 2026-10-20T08:52:12.326Z | 41392 | `f8a620cbc2592236c94f7982a56f91f418ed85d1368d149dd900d279cf813e8b` |
| 0022500657 | 2026-10-20T08:58:53.826Z | 41440 | `278b6883e465bd6f13832e4595b34d45d791b3df1da00ac3ed9724831a9c6015` |

What the boxes show, by game date (Eastern):

- Damian Lillard, POR. 2026-02-20 (0022500810) lists him INACTIVE_INJURY, "Left Achilles Tendon; Injury
  Management". 2026-02-22 at PHX (0022500826) does not list him at all. 2026-02-24 (0022500841) lists him
  again, INACTIVE_INJURY with the same description.
- Bones Hyland, MIN. 2025-02-27 at LAL (0022400849) lists him INACTIVE_GLEAGUE_TWOWAY. 2025-02-28 at UTA
  (0022400858) does not list him; ESPN's game summary for that game (event 401705424) does list him for MIN.
  2025-03-02 at PHX (0022400873) lists him again, INACTIVE_GLEAGUE_TWOWAY. Lillard's third box (POR against
  MIN, 2026-02-24) also lists Hyland, playing for MIN a season later.
- Charles Bassey, the control. 2025-11-05 (0022500176) lists him playing for MEM. MEM's next box,
  2025-11-07 (0022500034), and its next 33 omit him. PHI's box of 2026-01-26 (0022500657) lists him, so
  he had left MEM.

The players-t16 census of all 2,460 pinned regular-season boxes (evidence outside the repository) found
these and 17 other cases of a player whom his team's boxes list, then omit, then list again, with no
other team listing him in between.
