# Real boxes for players-t19-corroborated-identity

These are REAL-RAW NBA CDN final box scores, kept byte for byte as pinned in the task's replay store
(gzip of `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_<game>.json`). The hash in each file
name is the SHA-256 of the decompressed body; the recipe checks it before serving the body unchanged.
Retrieval times are the store's; the bodies describe games played long before them. They are every 2024-25
box that lists Yongxi Cui (1642385, "Cui Yongxi", BKN; ESPN 5159486 "Yongxi Cui"), in tip-off order, and the
box of Jakob Poeltl's control game (1627751, "Jakob Pöltl", TOR; ESPN 3134908 "Jakob Poeltl"), the same body
as players-t18-real-boxes.

| Game | Date (ET) | Teams | Retrieved (UTC) | Bytes | SHA-256 of the body | Line |
| --- | --- | --- | --- | --- | --- | --- |
| 0022400064 | 2024-10-23 | BKN at ATL | 2026-10-21T05:55:12.242Z | 41205 | `b19ca8e43287209d0625b1a595529758fe309dac01834a506259b0cd71fb2edf` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400067 | 2024-10-23 | CLE at TOR | 2026-10-21T05:55:14.020Z | 40331 | `b3d5bfb5e10f4a8ad3a1ff26b87ed4f69792c8b11fe4aef41029af4711873a03` | 1627751 Jakob Pöltl, TOR: 6 pts, 9 reb, 2 ast |
| 0022400077 | 2024-10-25 | BKN at ORL | 2026-10-21T05:55:20.752Z | 40039 | `5f2d00c7e440227ca58608ef0d273fc6745b60e78c0e841d76ec0afa6e1dfad4` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400098 | 2024-10-27 | MIL at BKN | 2026-10-21T05:55:35.869Z | 41120 | `cd1ff2f4908c3ad034a0159ae662f264c5952916c44808afb709f273327c3e0c` | 1642385 Cui Yongxi, BKN: 1 pts, 0 reb, 0 ast |
| 0022400113 | 2024-10-29 | DEN at BKN | 2026-10-21T05:55:45.835Z | 41410 | `a68059f86eb919412d428f97006aaca4ee3b3af938229b03b91dae8c328ed083` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400124 | 2024-10-30 | BKN at MEM | 2026-10-21T05:55:52.833Z | 41291 | `641f6ec802d6fe977863c0d8fedb66e4346ba4909952e209873211e5a272c360` | 1642385 Cui Yongxi, BKN: 0 pts, 0 reb, 0 ast |
| 0022400136 | 2024-11-01 | CHI at BKN | 2026-10-21T05:56:00.865Z | 41519 | `6d116df658f3caa29b91fed28bd343531636041e6f5d3c02fd73089594eba4e7` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400151 | 2024-11-03 | DET at BKN | 2026-10-21T05:56:11.061Z | 40401 | `3ea05d420a272ec63efebb549f22c7c38adacaed9b61a89dc7ed17d43b4444df` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400158 | 2024-11-04 | MEM at BKN | 2026-10-21T05:56:15.982Z | 41819 | `802b9f852a653f5d45b7cb547b31a0fdbff6d4a9356f65a7b5b23d89327e486f` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400187 | 2024-11-08 | BKN at BOS | 2026-10-21T05:56:35.752Z | 40667 | `765729d43ce41ccdb8e54f10a54c607c78e483a2213300c55fa7180a799301d7` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400199 | 2024-11-09 | BKN at CLE | 2026-10-21T05:56:43.817Z | 40334 | `c8af220ae624151a459aab5043663f061e6ee01803a6d93cabf8aaa9deb89ffb` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400214 | 2024-11-11 | BKN at NOP | 2026-10-21T05:56:54.116Z | 41711 | `0702c6dcc8ad4186eab168c21de75aa0f2df78080edf6a8ef626874e2fa2cc0b` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400218 | 2024-11-13 | BOS at BKN | 2026-10-21T05:56:56.679Z | 40595 | `67d42993a81e8a0b386c0984b2271ebdc494fc298b7d3c0c838debd9d84d1c2c` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400014 | 2024-11-15 | BKN at NYK | 2026-10-21T05:54:37.110Z | 40595 | `8d7b2e266a33e240789b9279ce141ef587a71d7c7fa0aad91806c3a5f5bfcee0` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400240 | 2024-11-17 | BKN at NYK | 2026-10-21T05:57:11.464Z | 40501 | `97b5154d521aaec553de59ea40eab142f33c715036f997f67e6ae578249255bf` | 1642385 Cui Yongxi, BKN: 0 pts, 0 reb, 0 ast |
| 0022400022 | 2024-11-19 | CHA at BKN | 2026-10-21T05:54:42.983Z | 41522 | `6c20269cf95b1f43061a9a4daca21df146808247224b776375a1049b00eb6767` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400027 | 2024-11-22 | BKN at PHI | 2026-10-21T05:54:46.474Z | 40358 | `a108d7ae2562c9258aa06ce946fc8207323463c0c7110b6727d6cb53bbbcab90` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400276 | 2024-11-24 | BKN at SAC | 2026-10-21T05:57:36.261Z | 40544 | `7cbf52603af57563d0aaba5a048730b9f54eea9ca3290efa679e3eec66f45767` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400284 | 2024-11-25 | BKN at GSW | 2026-10-21T05:57:41.576Z | 40800 | `f25f01c4c73a6cc083d152edeb5cddfefbc8ef00e3018f0c18e0f424865ec985` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400297 | 2024-11-27 | BKN at PHX | 2026-10-21T05:57:50.093Z | 40605 | `750629ae4dd4044072e6bc9f565f75d438bd98a955d9bcd5ed5af8350e491de7` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400043 | 2024-11-29 | ORL at BKN | 2026-10-21T05:54:57.337Z | 40545 | `eef103814ea7bffcd795e9bcaa3813f8e76407ffb030e2e50a57c691015b23d1` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400305 | 2024-12-01 | ORL at BKN | 2026-10-21T05:57:55.482Z | 40586 | `a4319eaaff24d531445c706021b5a3c92ab3ee3d9ff0524904ecb56c89465072` | 1642385 Cui Yongxi, BKN: 0 pts, 0 reb, 0 ast |
| 0022400317 | 2024-12-02 | BKN at CHI | 2026-10-21T05:58:03.641Z | 41637 | `14fc2e421d0984a6462c04ae0a888020f7d25198b2d7507a1361deeb97caa363` | 1642385 Cui Yongxi, BKN: 2 pts, 2 reb, 0 ast |
| 0022400320 | 2024-12-04 | IND at BKN | 2026-10-21T05:58:06.020Z | 41653 | `505e37685b8c6113aa82beb6e68b03fe53b04ca878fa179224e90a6d851a7352` | 1642385 Cui Yongxi, BKN: did not play |
| 0022400348 | 2024-12-08 | MIL at BKN | 2026-10-21T05:58:24.756Z | 41225 | `196ca08dda21d55382afd4a51852cbf8ee0276ee1da67b36faaefd210156031f` | 1642385 Cui Yongxi, BKN: did not play |
| 0022401211 | 2024-12-13 | BKN at MEM | 2026-10-21T06:08:21.522Z | 41638 | `5589f50b2ea10cfce383f311fa59596ad29a1af53de56e5ed956c42c0ef4e011` | 1642385 Cui Yongxi, BKN: did not play |

The player index the recipe serves is `tests/fixtures/identity/player-index.json` (REAL-RAW, SHA-256
`535d3e59be84f9dd6ff194bc968b6d6cbb4f8cd5fa30380012bf7cd02110c966`). It does not list Cui; it lists Poeltl
once, as "Jakob Poeltl" with roster status 1. The first sync-players serves it re-serialized without
Poeltl's row.
