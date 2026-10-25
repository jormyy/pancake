import hashlib
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('localhost', '127.0.0.1') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback stack is allowed')
if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
    raise SystemExit('Gate comparison runs only in the assigned mini copy')


def sql(statement):
    result = subprocess.run(['psql', os.environ['SUPABASE_DB_URL'], '-XqAt', '--set', 'ON_ERROR_STOP=1'],
                            input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout.strip()


def definition():
    return sql("SELECT pg_get_functiondef('public.get_live_poll_work(timestamptz)'::regprocedure)")


def measure(phase):
    for name, file in [('idle', 'tests/db/weekly-idle-load.sql'), ('night', 'scripts/mutation/live/game-night-load.sql')]:
        subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', '../evidence/round7',
                        '--name', f'{phase}-{name}-timed', 'psql', os.environ['SUPABASE_DB_URL'],
                        '-X', '--set', 'ON_ERROR_STOP=1', '-f', file], check=True)


original = definition()
assert original.count("p_now-interval '45 minutes'") == 2
try:
    sql(original.replace("p_now-interval '45 minutes'", "p_now-interval '10 minutes'"))
    measure('before')
finally:
    sql(original)
    assert definition() == original, 'Restored definition differs'
    print('revert_sha256=' + hashlib.sha256(original.encode()).hexdigest(), flush=True)
measure('after')
