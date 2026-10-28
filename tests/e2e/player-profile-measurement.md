# Player profile measurement

Use only the private `pt4bafableui7` stack on ports `577xx`.
Run these checks on the Mac mini.

1. Run `node tests/e2e/player-profile-local-setup.mjs --build`.
2. Run `npm run e2e:seed` against the private stack.
3. Apply `tests/e2e/player-profile-fixture.sql` to its database.
4. Serve `dist` on port `57780`.
5. Run `node tests/e2e/player-profile-capture.mjs before` before the profile change.
6. Apply the player view SQL and build the changed app.
7. Run `node tests/e2e/player-profile-capture.mjs after`.

The capture uses a separate browser and blocks external hosts.
It records response body bytes, request paths, screenshots, and browser errors.
The local fixture has 80 game entries and one news item.

## Captured result

The private fixture contains 80 games, an injury, news, and a next game.
The capture measures decoded response-body bytes.

| Read | Before requests | Before bytes | After requests | After bytes |
| --- | ---: | ---: | ---: | ---: |
| Cold player view | 1 | 122,962 | 1 | 4,746 |
| Warm player view | 1 | 122,962 | 1 | 4,746 |
| Cold screen, including shared reads | 3 | 125,377 | 3 | 7,161 |
| Warm screen, including shared reads | 4 | 128,790 | 4 | 10,574 |

The player view shrinks by 96.1%.
The warm screen paints cached data before an 800 ms delayed refresh response.
Each closed section makes one view request when opened.
Game log: 22,804 bytes. News: 2,359 bytes. History: 2,104 bytes.
The browser reports no page errors.

Raw captures and screenshots are saved with the task evidence outside this repository.
The matching view migration and generated attestations pass source-parity checks.
