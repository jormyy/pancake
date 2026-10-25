import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlparse

root = Path.cwd()
evidence = root / 'evidence'
evidence.mkdir(exist_ok=True)
env = dict(os.environ)
for line in (root / 'raw/stack.env').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        env[key] = value.strip('"')
env.update(SUPABASE_URL=env['API_URL'], SUPABASE_DB_URL=env['DB_URL'],
           PANCAKE_SUPABASE_SECRET_KEY=env['SECRET_KEY'],
           PANCAKE_EDGE_INTERNAL_TOKEN='local-database-ci-token',
           E2E_SUPABASE_PUBLISHABLE_KEY=env['PUBLISHABLE_KEY'],
           PANCAKE_TEST_API_PORT='57721', PANCAKE_TEST_DB_PORT='57722')
for name, port in [('SUPABASE_URL', 57721), ('SUPABASE_DB_URL', 57722)]:
    target = urlparse(env[name])
    assert target.hostname in ['127.0.0.1', 'localhost'] and target.port == port


def run(name, command, statement=None):
    start = time.monotonic()
    result = subprocess.run(command, input=statement, env=env, capture_output=True, text=True, timeout=300)
    log = 'evidence/' + name + '-' + str(time.time_ns()) + '.log'
    (root / log).write_text(result.stdout + result.stderr)
    row = dict(name=name, command=command, exit=result.returncode,
               seconds=round(time.monotonic() - start, 3), log=log)
    with (evidence / 'commands.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)
    if result.returncode:
        print((result.stdout + result.stderr)[-3500:], flush=True)
    return row


psql = ['psql', env['SUPABASE_DB_URL'], '-XqAt', '-v', 'ON_ERROR_STOP=1']
deno = ['deno', 'run', '--no-lock', '--check', '--allow-env',
        '--allow-net=127.0.0.1,localhost,0.0.0.0', '--allow-read', '--allow-write=evidence',
        '--allow-run=psql']
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['red', 'apply', 'regressions', 'rookies', 'checks', 'mutations', 'continuity', 'pin'])
parser.add_argument('--knip-config')
args = parser.parse_args()
if args.mode == 'red':
    for name, remove in [('identity-merge-support', ['Identity merge loses the rookie ranking player link']),
                         ('identity-nba-trade-locks', ['Stale NBA team locks the player to his former team game',
                                                       'Stale NBA team locks roster status to the former team game'])]:
        statement = (root / ('tests/db/' + name + '.sql')).read_text()
        for message in remove:
            statement = statement.replace("RAISE EXCEPTION '" + message + "'", "RAISE NOTICE '" + message + "'")
        (evidence / ('red-independent-' + name + '.sql')).write_text(statement)
        run('red-independent-' + name, psql + ['-f', 'evidence/red-independent-' + name + '.sql'])
elif args.mode == 'apply':
    row = run('apply-identity-migration', psql + ['-f', 'supabase/migrations/20261020000130_preserve_player_identity_support_and_game_locks.sql'])
    assert row['exit'] == 0
elif args.mode == 'regressions':
    for wave in range(1, 3):
        for name in ['identity-first-box', 'identity-merge-support', 'identity-nba-trade-locks']:
            assert run('green-' + name + '-' + str(wave), psql + ['-f', 'tests/db/' + name + '.sql'])['exit'] == 0
    for name in ['player-imports', 'cdn-player-identity-correction', 'player-identity-claim',
                 'draft-board-experience-fence', 'sparse-player-merge', 'historical-lineup-lock', 'rookie-drafting-gate']:
        assert run(name, psql + ['-f', 'tests/db/' + name + '.sql'])['exit'] == 0
    for name in ['player-name-parity', 'rookie-activation-actor', 'rookie-backstop', 'rookie-skipped-week']:
        assert run(name, deno + ['supabase/tests/db/' + name + '.ts'])['exit'] == 0
elif args.mode == 'rookies':
    for wave in range(1, 3):
        assert run('identity-rookies-' + str(wave), deno + ['supabase/tests/db/identity-rookies.ts'])['exit'] == 0
elif args.mode == 'continuity':
    for wave in range(1, 3):
        assert run('identity-continuity-' + str(wave), deno + ['supabase/tests/db/identity-continuity.ts'])['exit'] == 0
elif args.mode == 'checks':
    commands = [
        ('db-sources', ['node', 'scripts/check-db-function-sources.mjs', '--check']),
        ('edge-shared', ['node', 'scripts/generate-edge-shared.mjs', '--check']),
        ('edge-functions', ['npm', 'run', 'check:edge-functions']),
        ('typecheck-e2e', ['npm', 'run', 'typecheck:e2e']),
        ('knip', ['npx', 'knip', '--no-progress', '--no-config-hints'] + (['--config', args.knip_config] if args.knip_config else [])),
        ('eslint', ['npx', 'eslint', 'supabase/tests/db/identity-rookies.ts', 'supabase/tests/db/identity-continuity.ts', 'supabase/tests/db/identity-db.ts',
                    'supabase/functions/sync-players/index.ts', 'supabase/functions/sync-players/nbaIds.ts',
                    'supabase/functions/sync-players/imports.test.ts', '--max-warnings=0']),
        ('deno-check', ['deno', 'check', '--no-lock', 'supabase/tests/db/identity-rookies.ts', 'supabase/tests/db/identity-continuity.ts', 'supabase/functions/sync-players/nbaIds.ts', 'supabase/functions/sync-players/imports.test.ts']),
        ('identity-unit-tests', ['deno', 'test', '--no-lock', '--allow-env', '--allow-net', '--allow-read',
                    'supabase/functions/_shared/playerResolver.test.ts', 'supabase/functions/sync-players/imports.test.ts']),
        ('source-observability', ['npx', 'vitest', 'run', 'tests/e2e-source-observability-contract.test.ts']),
    ]
    failed = False
    for name, command in commands:
        failed = run(name, command)['exit'] != 0 or failed
    if failed:
        raise SystemExit(1)
elif args.mode == 'mutations':
    exec((root / 'scripts/mutation/identity/mutate.py').read_text())

elif args.mode == 'pin':
    assert run('pin-real-identity-inputs', ['python3', 'scripts/mutation/identity/pin.py'])['exit'] == 0
