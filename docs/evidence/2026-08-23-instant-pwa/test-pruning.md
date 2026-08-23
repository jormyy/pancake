# Test pruning audit

Date: 2026-08-23

## Result

No test met the deletion standard. The audit removed zero tests.

## Before

- Command: `/usr/bin/time -p npm test`
- Files: 110
- Tests: 625
- Vitest time: 1.45 seconds
- Wall time: 1.69 seconds
- Coverage: unavailable because this repository has no coverage command or provider

## Audit

- No unit test file lacked an assertion.
- No unit test used a permanent skip or exclusive run.
- No snapshot file or snapshot assertion existed.
- No framework-only or code-shape test qualified for deletion.
- The roster suites appeared to repeat core eligibility behavior.
- A temporary source mutation failed only the core suite.
- The application suite used the built package and remained green.
- The suites therefore protect different artifacts.
- The source mutation was restored before the audit continued.

## After

- Command: `/usr/bin/time -p npm test`
- Files: 110
- Tests: 625
- Vitest time: 1.49 seconds
- Wall time: 1.73 seconds
- Coverage: unavailable because this repository has no coverage command or provider

No deletion commit is required.
