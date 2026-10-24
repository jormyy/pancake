import hashlib
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback stack is allowed')
if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
    raise SystemExit('Origin control runs only in the assigned mini copy')
file = Path('supabase/functions/_shared/syncScores.ts')
original = file.read_text()
fragment = '            input_token: liveInputToken,\n'
assert original.count(fragment) == 1
try:
    file.write_text(original.replace(fragment, ''))
    subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', '../evidence/round8',
                    '--name', 'pre-certificate-control', 'npm', 'run', 'test:db:playoff-consumption'], check=True)
finally:
    file.write_text(original)
    assert file.read_text() == original
    print('revert_sha256=' + hashlib.sha256(original.encode()).hexdigest(), flush=True)
