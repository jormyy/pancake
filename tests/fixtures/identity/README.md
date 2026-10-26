# Identity inputs

These files contain real NBA data. Test leagues, ownership, support rows, and clocks are synthetic.

| File | Class | Source |
| --- | --- | --- |
| draft-2025.html | REAL-RAW | https://www.nba.com/news/2025-nba-draft-order |
| player-index.json | REAL-RAW | https://cdn.nba.com/static/json/staticData/playerIndex.json?season=2025-26 |
| rookies-2025.json | REAL-DERIVED | Draft article plus 1,230 pinned 2025-26 NBA CDN box scores |
| veterans-2024.json | REAL-DERIVED | Real 2024-25 NBA CDN box scores |
| games-2024.json | REAL-DERIVED | Schedule fields from those 2024-25 box scores |
| games-2025.json | REAL-DERIVED | Schedule fields from the pinned 2025-26 box scores |
| trades-2025.json | REAL-DERIVED | Dončić rows before and after DAL → LAL |
| trade-harden.json | REAL-DERIVED | Harden's last played LAC game and first four played CLE games |
| boxscore-0022400768.json | REAL-RAW | Dončić debut, NBA CDN boxscore, captured final |
| boxscore-0022500756.json | REAL-RAW | Harden debut, pinned NBA CDN boxscore, captured final |

The draft article arrives on 2026-10-21 at 05:52:54 UTC. It still names the complete 2025 class.
Its SHA256 is `b07024982ea4c9093827d89b31a96849d7aa0e5fe67771a3f540d28cbf9a8a13`.
The index arrives on 2026-10-21 at 05:54:55 UTC. Its SHA256 is `535d3e59be84f9dd6ff194bc968b6d6cbb4f8cd5fa30380012bf7cd02110c966`.
The index request without the query returns 403. The query supplies an unchanged real response, not a historical index.

The borrowed boxes were pinned from the NBA CDN and are kept unchanged outside the repository.
Their original retrieval times are unavailable here. Each decompressed SHA256 matches its source filename.
Acquisition provenance (URL, source path, byte count, and hash) is kept outside the repository.
The acquisition script regenerates derived files from those boxes and the pinned raw inputs.

The resolver checks 57 box-score identities. Only 55 drafted players play.
Sorber and Toohey have DNP rows. Marković and Niang have no box-score identity in these inputs.
Those four picks do not count as played coverage. Other observed players appear in the external undrafted report.
The rookie and continuity recipes write their TSV reports to `evidence/` in the checkout and create that ignored folder when it is missing.

The scoring recipe uses one long test week to isolate identity from calendar behavior.
It preserves real game dates, IDs, points, names, and teams. It does not prove the real fantasy calendar.

The membership recipe replays these final boxes as live responses.
Game clocks, ownership and stat failures are synthetic.
The captured payloads are not historical first-poll snapshots.
