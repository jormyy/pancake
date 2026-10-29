# Split player identities

The supplied backup contains these nine pairs. Each pair has one NBA row and one Sleeper row.
Neither row has an ESPN ID or NBA team. ESPN import therefore finds two eligible name matches.
The NBA rows were created on March 27, 2026. The Sleeper rows were created on March 26, 2026.
These dates show separate ingestion batches. They do not prove which historical code created each split.

| Player | NBA candidate UUID | NBA ID | Sleeper candidate UUID | Sleeper ID | Cause of ambiguity |
| --- | --- | --- | --- | --- | --- |
| Lonzo Ball | 31400ad5-023a-4af2-9b58-1ddb91f716f3 | 1628366 | 6a309e1f-09a4-470c-ba3b-780416951025 | 1798 | Same normalized name; disjoint provider IDs; both teams absent |
| Luke Travers | e7a4f757-8db2-46e9-b002-6c2199076332 | 1631247 | cf47d8a7-366d-4ad8-83ed-7eaefa8f2c22 | 2487 | Same normalized name; disjoint provider IDs; both teams absent |
| N'Faly Dante | ad6c3329-5a1c-47df-b811-96fc70818551 | 1642368 | 263355dd-792e-467e-bfe4-5e9071683ca4 | 2756 | Same normalized name; disjoint provider IDs; both teams absent |
| Jaden Springer | 9869afbe-9afd-4c3d-87ff-b48ae0f9013e | 1630531 | 167d6179-fefb-4223-b0e1-0aa29b119579 | 2264 | Same normalized name; disjoint provider IDs; both teams absent |
| Colby Jones | 6e471c98-ef70-4d49-93ce-e6e4b5a620c0 | 1641732 | 91c2f7ec-a1ca-4905-9472-e44eaf576b84 | 2616 | Same normalized name; disjoint provider IDs; both teams absent |
| Chris Boucher | 3dd4e3b2-e69b-4d94-ab08-6b60266c85dd | 1628449 | cca8fa2d-5a78-467a-870d-9b10c887739e | 1771 | Same normalized name; disjoint provider IDs; both teams absent |
| Nigel Hayes-Davis | 08235a57-b082-45bf-b8a0-9ec2418b5db2 | 1628502 | 0177dacd-4475-4223-bf9b-570844588745 | 1800 | Same normalized name; disjoint provider IDs; both teams absent |
| Johnny Juzang | 258862b0-cf65-4bf7-9cde-f7f42a54241f | 1630548 | 90a8c553-1b78-41e6-b4bd-3c59734c9d8d | 2413 | Same normalized name; disjoint provider IDs; both teams absent |
| Dario Saric | a21911b7-d110-4d9c-9564-8718fc016679 | 203967 | 5cbafda5-07c1-416d-ae04-9d762a71ee5b | 1674 | Same normalized name; disjoint provider IDs; both teams absent |

Evidence: `~/Documents/pancake-season-mission/fable/program3/evidence/identity-review.json`.
Backup data SHA-256: `1be49c65ad832c4976e62dbcf5828d22864311f7a24cb94556d8291a7fe03961`.

The repair must use a general identity rule. Conflicting provider IDs, known birthdates, or distinct names must remain separate.
A name match alone must not join two established NBA identities.

The repair first joins unique NBA and ESPN roster names on the same team.
It uses the NBA owner and the corroborated ESPN ID before importing ESPN metadata.
A missing-team Sleeper row can merge only when it is the sole compatible counterpart.
The pair must have compatible provider IDs, known birthdates, and known experience values.
A third candidate or conflicting provider ID blocks that merge.
The canonical row keeps the NBA ID, while the existing merge function moves its references and history.
No player name or provider ID appears in the repair rule.

The restored replay verifies all nine pairs after the repair.
Each NBA candidate UUID remains and owns its expected NBA, Sleeper, and ESPN IDs.
Each corresponding Sleeper candidate UUID is gone.
Evidence: `~/Documents/pancake-season-mission/fable/program3/evidence/captured/d86ae44c-de22-4975-b568-808bd65659d3/identity-repair.json`.


The same prelink step now covers a single known NBA owner after a team change.
A failing unit test exposes the skipped link when only one candidate exists.
The restored replay passes its first historical-team check after this repair.
Its later waiver failure does not establish complete two-day acceptance.
All nine pairs also pass in the latest restored replay. Evidence: `~/Documents/pancake-season-mission/fable/program3/evidence/captured/4a7f741d-37f9-49b2-bf50-45b8c2555d1f/identity-repair.json`.
