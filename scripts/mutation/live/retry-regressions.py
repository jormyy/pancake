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
    'live-score-overlap', 'live-score-guards', 'live-poll-delayed-tipoff', 'scoring-partial-failure',
    'player-score-revisions', 'playoff-transitions', 'playoff-spans', 'playoff-consumption',
    'playoff-seed-corrections', 'playoff-boundary-races', 'playoff-boundary-guards',
    'playoff-pending-corrections', 'playoff-missing-stats',
]
for recipe in recipes:
    for attempt in [1, 2]:
        subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', '../evidence/round8',
                        '--name', f'{recipe}-{attempt}', 'npm', 'run', 'test:db:' + recipe], check=True)
