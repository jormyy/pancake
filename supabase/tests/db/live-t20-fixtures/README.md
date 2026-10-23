# Fixtures for live-t20-admin-merge, live-t20-exact-instant and live-t20-merge-since

No new data file. `live-t20-exact-instant.ts` and `live-t20-merge-since.ts` are synthetic (one rolled-back
transaction per case) and read nothing here. `live-t20-admin-merge.ts` reads the live-t19 merge listing
(`live-t19-fixtures/listing-merge.json.gz`, SHA-256 of the document
`e9cd5fbde11d60eb2da9a8b51bfc7cd26aa6105adafdc3fb2690217cfb55a241`) and the nine Brooklyn and Clippers boxes it
stores, from 2025-02-08 through 2025-02-23, byte for byte from the first of `live-t19-fixtures/`,
`live-t18-fixtures/` and `live-t17-fixtures/` that carries each (`live-t18-fixtures/README.md` lists them). The
recipe checks every file by SHA-256 and byte count, and serves each box unchanged once its game has been played.

## Constructed in the recipe

The listing's own constructed rows for Ben Simmons (NBA 1627732) are changed in memory, in two ways only:

- **ESPN lists him where the derivation's real rosters do.** The derivation omits him from ESPN on 2025-02-10 to
  02-13; each such row names the page it took him off (`omittedFrom`), and the recipe puts him back on that page.
  ESPN then lists him on Brooklyn to 02-11 and on the Clippers from 02-12, so he is never an ESPN omission.
- **The player index leaves him out on every refresh** (the derivation lists him from 02-13). ESPN names him
  "Benjamin Simmons" and the box "Ben Simmons", so no name, no link and no index step joins them: his first
  Clippers box (2025-02-12) creates a row of its own (his NBA id, his boxes and their memberships under LAC). That
  is the split the admin merge repairs.

Nothing else in the listing or the boxes changes. Every other tracked player follows the feed.

## Calendar and league

Member A owns Simmons and James Harden, member B Ivica Zubac and Nic Claxton; two UTIL slots each, so a healthy
player whose team plays that day is started. Scoring: points 1, rebounds 1, assists 2, steals 3, blocks 3,
turnovers -1.

| Week | Dates | sync-scores run | Note |
| --- | --- | --- | --- |
| 1 | 2025-02-03 to 02-09 | 02-10 17:00Z | |
| 2 | 2025-02-10 to 02-13 | 02-14 17:00Z | his first two Clippers games (the split week) |
| 3 | 2025-02-14 to 02-19 | 02-20 17:00Z | the All-Star break |
| 4 | 2025-02-20 to 02-23 | 02-24 17:00Z | after the merge |

The admin merge runs on 2025-02-20, after week 3 is finalized and before that day's ESPN refresh; the next
sync-scores run (02-20 17:00Z) is the product's stale-week path for week 2.

## Expected points (predict.py)

`python3 -I predict.py <repo>` recomputes these from the committed fixtures alone.

His pinned lines: 2025-02-12 LAC at UTA (0022400783), DNP, 0; 02-13 (0022401004) 12 points, 43 fantasy;
02-20 (0022400793) 25; 02-23 (0022400813) 24. He is started on 02-10 (Brooklyn, no line), 02-12, 02-13, 02-20
and 02-23.

| Week | A-B before the merge (his lines on the split row) | A-B after the merge |
| --- | --- | --- |
| 1 | 60-59 | 60-59 |
| 2 | 115-142 | 158-142 |
| 3 | 0-0 | 0-0 |
| 4 | | 165-164 |
