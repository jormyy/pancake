# PWA paint probe

- Started: 2026-09-13T04:25:10.733Z
- Frontend: http://127.0.0.1:8081 route /roster
- Allocation: 20 launches, alternating fresh (own session, full gate prelude, closed after) / reused (one session kept across all reused launches; prelude once, then measured relaunches only)
- Sequence: gate prelude: open "/", clear localStorage, open "/", wait 2500 ms, sign in, wait 2000 ms; then early observer, one measured open of the route, wait, read, screenshot
- Gate: FCP present (finite, >= 0) and <= 400 ms; a missing entry is a failure and says nothing about speed
- agent-browser: agent-browser 0.25.4
- User agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36

Fresh: 10/10 pass. Reused: 10/10 pass. Early observer registered on 20, ran on 20. Buckets: pass=20, budget=0, missing:early-saw=0, missing:early-none=0, missing:early-error=0, missing:late-observer-saw=0, missing:no-evidence=0, probe-error=0.

Reader limit: when the early observer did not run, the remaining readers are post-navigation and an empty result cannot distinguish an evicted or unbuffered entry from one the engine never produced.

| # | mode | status | bucket | reason | prelude | setup attempts | measured nav attempts | early observer | paint (early) | paint (byType) | paint (late observer) | shell ms | mount ms | visible | focus | nav |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | fresh | PASS | pass | fcp 20ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 7.5 | 36.2 | visible | true | navigate |
| 2 | reused | PASS | pass | fcp 24ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@24 first-contentful-paint@24 | first-paint@24 first-contentful-paint@24 | first-paint@24 first-contentful-paint@24 | 10.0 | 37.2 | visible | true | navigate |
| 3 | fresh | PASS | pass | fcp 20ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 8.8 | 35.1 | visible | true | navigate |
| 4 | reused | PASS | pass | fcp 16ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 5.6 | 28.6 | visible | true | navigate |
| 5 | fresh | PASS | pass | fcp 16ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 5.1 | 25.4 | visible | true | navigate |
| 6 | reused | PASS | pass | fcp 16ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 4.7 | 28.8 | visible | true | navigate |
| 7 | fresh | PASS | pass | fcp 24ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@24 first-contentful-paint@24 | first-paint@24 first-contentful-paint@24 | first-paint@24 first-contentful-paint@24 | 9.8 | 36.6 | visible | true | navigate |
| 8 | reused | PASS | pass | fcp 16ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 5.9 | 32.3 | visible | true | navigate |
| 9 | fresh | PASS | pass | fcp 20ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 7.3 | 34.5 | visible | true | navigate |
| 10 | reused | PASS | pass | fcp 16ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 4.6 | 28.7 | visible | true | navigate |
| 11 | fresh | PASS | pass | fcp 20ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 7.5 | 33.7 | visible | true | navigate |
| 12 | reused | PASS | pass | fcp 20ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 6.2 | 32.2 | visible | true | navigate |
| 13 | fresh | PASS | pass | fcp 16ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 5.1 | 25.8 | visible | true | navigate |
| 14 | reused | PASS | pass | fcp 20ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 6.1 | 36.5 | visible | true | navigate |
| 15 | fresh | PASS | pass | fcp 16ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 6.4 | 29.4 | visible | true | navigate |
| 16 | reused | PASS | pass | fcp 20ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | first-paint@20 first-contentful-paint@20 | 8.6 | 37.5 | visible | true | navigate |
| 17 | fresh | PASS | pass | fcp 16ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 4.9 | 25.1 | visible | true | navigate |
| 18 | reused | PASS | pass | fcp 12ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@12 first-contentful-paint@12 | first-paint@12 first-contentful-paint@12 | first-paint@12 first-contentful-paint@12 | 4.6 | 28.6 | visible | true | navigate |
| 19 | fresh | PASS | pass | fcp 16ms <= 400ms | full gate prelude | 3 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 5.6 | 25.8 | visible | true | navigate |
| 20 | reused | PASS | pass | fcp 16ms <= 400ms | none (session already signed in) | 0 | 1 | ran | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | first-paint@16 first-contentful-paint@16 | 4.7 | 25.3 | visible | true | navigate |
