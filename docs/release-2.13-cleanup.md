# Release 2.13 cleanup

Raw measurement outputs are reproducible through the retained pipeline-night recipes.
No removed JSON file is imported or read as a test fixture.

| Removed path | Bytes |
| --- | ---: |
| `tests/db/pipeline-night-cleanup.json` | 165 |
| `tests/db/pipeline-night-forecast-cleanup.json` | 429 |
| `tests/db/pipeline-night-forecast-results.json` | 90862 |
| `tests/db/pipeline-night-input-recovery-results.json` | 106224 |
| `tests/db/pipeline-night-local-cleanup.json` | 367 |
| `tests/db/pipeline-night-local-results.json` | 328758 |
| `tests/db/pipeline-night-recovery-cleanup.json` | 399 |
| `tests/db/pipeline-night-results.json` | 952527 |
| `tests/db/pipeline-night-verification.json` | 2618 |
| `tests/db/pipeline-night-worker-cleanup.json` | 464 |
| `tests/db/pipeline-night-worker-results.json` | 12605 |

Removed 11 files, 1495418 bytes.
