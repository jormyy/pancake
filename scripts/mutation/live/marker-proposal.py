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
    raise SystemExit('Proposal checks run only in the assigned mini copy')


def sql(statement):
    result = subprocess.run(['psql', os.environ['SUPABASE_DB_URL'], '-XqAt', '--set', 'ON_ERROR_STOP=1'],
                            input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
    return result.stdout.strip()


def definition():
    return sql("SELECT pg_get_functiondef('public.save_live_scoreboard_atomic(uuid,text,text,integer,integer,text,numeric)'::regprocedure)")


original = definition()
fragment = 'game_status_text=p_status_text,live_scoreboard_elapsed_seconds'
replacement = """game_status_text=CASE WHEN NOT private.lineup_game_available(v_game.status,v_game.game_status_text)
      AND p_status='Scheduled' AND private.lineup_game_available(p_status,p_status_text)
      THEN v_game.game_status_text ELSE p_status_text END,live_scoreboard_elapsed_seconds"""
assert original.count(fragment) == 1
try:
    sql(original.replace(fragment, replacement))
    for name, command in [
        ('proposal-probe', ['psql', os.environ['SUPABASE_DB_URL'], '-X', '--set', 'ON_ERROR_STOP=1', '-f', 'tests/db/calendar-live-marker.sql']),
        ('proposal-cross', ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql', 'supabase/tests/db/makeup-scoring.ts', 'cross']),
        ('proposal-same', ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql', 'supabase/tests/db/makeup-scoring.ts', 'same']),
    ]:
        subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', '../evidence/round10',
                        '--name', name] + command, timeout=120, check=True)
finally:
    sql(original)
    assert definition() == original, 'Restored deployed definition differs'
    print('proposal_revert_sha256=' + hashlib.sha256(original.encode()).hexdigest(), flush=True)
