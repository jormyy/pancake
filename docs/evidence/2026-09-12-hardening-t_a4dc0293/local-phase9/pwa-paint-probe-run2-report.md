# PWA paint probe

- Started: 2026-09-13T03:43:27.660Z
- Frontend: http://127.0.0.1:8081 route /roster
- Allocation: 20 launches, alternating fresh (own session, closed after) / reused (one session kept across all reused launches)
- Gate: FCP present and <= 400 ms; a missing entry is a failure and says nothing about speed
- agent-browser: agent-browser 0.25.4
- User agent: n/a

Fresh: 0/10 pass. Reused: 0/10 pass. Early observer installed on 0 launches. Missing by getEntriesByType but seen by the early observer: 0. Missing everywhere with the early observer installed: 0. Missing by getEntriesByType but present via late buffered observer: 0. No late-reader evidence (no early observer): 0. Probe errors: 20.

Reader limit: the late readers run after the measured navigation; without an installed early observer an empty result cannot distinguish an evicted or unbuffered entry from one the engine never produced.

| # | mode | status | reason | setup attempts | measured nav attempts | early observer | paint (early) | paint (byType) | paint (late observer) | shell ms | mount ms | visible | focus | nav |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 2 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 3 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 4 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 5 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 6 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 7 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 8 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 9 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 10 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 11 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 12 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 13 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 14 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 15 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 16 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 17 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 18 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 19 | fresh | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
| 20 | reused | FAIL | probe error: Expected property name or '}' in JSON at position 1 (line 1 column 2) | 0 | 0 | - | - | - | - | - | - | - | - | - |
