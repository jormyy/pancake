# Real boxes for players-t18-renamed-identity

These are REAL-RAW NBA CDN final box scores, kept byte for byte as pinned in the task's replay store
(gzip of `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file
name is the SHA-256 of the decompressed body; the recipe checks it before serving the body unchanged.
Retrieval times are the store's; the bodies describe games played long before them.

| Game | Retrieved (UTC) | Bytes | SHA-256 of the body |
| --- | --- | --- | --- |
| 0022400067 | 2026-10-21T05:55:14.020Z | 40331 | `b3d5bfb5e10f4a8ad3a1ff26b87ed4f69792c8b11fe4aef41029af4711873a03` |
| 0022400073 | 2026-10-21T05:55:17.977Z | 40241 | `63d80e676306570d6c91ad38ff72f9c925e9ae0d97427cda2ca69a17d43a3db8` |
| 0022400098 | 2026-10-21T05:55:35.869Z | 41120 | `cd1ff2f4908c3ad034a0159ae662f264c5952916c44808afb709f273327c3e0c` |

The player index the recipe serves is `tests/fixtures/identity/player-index.json` (REAL-RAW, SHA-256
`535d3e59be84f9dd6ff194bc968b6d6cbb4f8cd5fa30380012bf7cd02110c966`, the same body as the replay store's
`player-index` entry retrieved 2026-10-21T05:56:32.803Z). It lists Poeltl (1627751), Sarr (1642259) and
Carrington (1642267) under ESPN's names with roster status 1, and it does not list Cui (1642385). The case
"index without his row" serves that index re-serialized without those three rows.

Each person, as the box names him and as ESPN's summary of the same game names him (pinned in the same store):

| Person | Box | CDN name, team, line | ESPN summary (event, retrieved, SHA-256 of the body) | ESPN name, id |
| --- | --- | --- | --- | --- |
| 1627751 | 0022400067, 2024-10-23 | Jakob Pöltl, TOR, played | 401704633, 2026-10-21T05:55:15.018Z, `3220291a5ab29e61f2f115164e6ae0a8e90143368bd6c2db1f919eb421f53288` | Jakob Poeltl, 3134908 |
| 1642259 | 0022400073, 2024-10-24 | Alexandre Sarr, WAS, played | 401704639, 2026-10-21T05:55:19.077Z, `fc2faa9d310c0333a593a82670381346bad01d0ed6107b5dbcacfbf4c1102ed1` | Alex Sarr, 5160992 |
| 1642267 | 0022400073, 2024-10-24 | Carlton Carrington, WAS, played | same as above | Bub Carrington, 4845374 |
| 1642385 | 0022400098, 2024-10-27 | Cui Yongxi, BKN, played (1 point) | 401704664, 2026-10-21T05:55:36.792Z, `1a0cae4353b7e7fad6faae8ca214dc845a19c8c57eac68b8585451f408ac6bce` | Yongxi Cui, 5159486 |

ESPN's last pinned summary names each of them the same way. The CDN's own `firstName`/`familyName` fields for
Cui are "Cui"/"Yongxi", so the box carries no given-name-first form either. The pairs come from the players-t18
identity census of all 2,460 pinned regular-season boxes (evidence outside the repository): 14 Pöltl rows, 41
Alexandre Sarr rows, 41 Carlton Carrington rows and 25 Cui Yongxi rows, all 2024-25.
