import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback stack is allowed')
if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
    raise SystemExit('Regression checks run only in the assigned mini copy')
recipes = [
    'postponed-scoring', 'postponed-score-access', 'live-score-overlap', 'live-score-guards',
    'live-poll-delayed-tipoff', 'scoring-partial-failure', 'scoring-skip-first-week',
    'skipped-week-certificates', 'game-stats-completion', 'player-score-revisions',
    'playoff-consumption', 'playoff-spans', 'playoff-missing-stats',
]
for recipe in recipes:
    for attempt in [1, 2]:
        prefix = 'evidence:db:' if recipe == 'scoring-skip-first-week' else 'test:db:'
        subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', '../evidence/round9',
                        '--name', f'{recipe}-{attempt}', 'npm', 'run', prefix + recipe], check=True)
