import argparse
from pathlib import Path

exec(Path(__file__).with_name('run.py').read_text().split('parser = argparse.ArgumentParser()', 1)[0])
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['checks', 'mutations'])
args = parser.parse_args()
concurrency = ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-run=psql',
               'supabase/tests/db/identity-import-concurrency.ts']
unit = ['deno', 'test', '--no-lock', '--allow-env', '--allow-net', '--allow-read',
        'supabase/functions/_shared/playerResolver.test.ts']
if args.mode == 'checks':
    files = ['supabase/functions/_shared/playerImports.ts', 'supabase/functions/_shared/playerResolver.test.ts',
             'supabase/tests/db/identity-import-concurrency.ts']
    commands = [
        ('round4-eslint', ['npx', 'eslint', *files, '--max-warnings=0']),
        ('round4-deno-check', ['deno', 'check', '--no-lock', *files]),
        ('round4-db-sources', ['node', 'scripts/check-db-function-sources.mjs', '--check']),
        ('round4-edge-shared', ['node', 'scripts/generate-edge-shared.mjs', '--check']),
        ('round4-edge-functions', ['npm', 'run', 'check:edge-functions']),
        ('round4-typecheck-e2e', ['npm', 'run', 'typecheck:e2e']),
        ('round4-knip-default', ['npx', 'knip', '--no-progress', '--no-config-hints']),
    ]
    failed = []
    for name, command in commands:
        if run(name, command)['exit']:
            failed.append(name)
    if failed == ['round4-knip-default']:
        config = json.loads((root / 'knip.json').read_text())
        config['workspaces']['.']['entry'].append('supabase/tests/db/identity-import-concurrency.ts')
        config_path = evidence / 'knip-round4-pending-registration.json'
        config_path.write_text(json.dumps(config, indent=2) + '\n')
        assert run('round4-knip-pending-registration', ['npx', 'knip', '--no-progress', '--no-config-hints', '--config', str(config_path)])['exit'] == 0
    elif failed:
        raise SystemExit('Failed checks: ' + ', '.join(failed))
else:
    for name, command in [('optimizer', concurrency + ['optimizer']), ('stats', concurrency + ['stats']), ('retry', unit)]:
        assert run('round4-mutation-baseline-' + name, command)['exit'] == 0
    sql_path = 'supabase/sql/functions/by-name/public/resolve_player_imports_atomic.sql'
    migration = 'supabase/migrations/20261020000132_order_player_import_locks.sql'
    ts_path = 'supabase/functions/_shared/playerImports.ts'
    mutations = [
        ('L01', sql_path, 'removed ORDER BY', '    ORDER BY p.id FOR UPDATE;', '    FOR UPDATE;', concurrency + ['optimizer']),
        ('L02', sql_path, 'removed game lock statement', "    PERFORM g.id FROM nba_games AS g\n      WHERE g.nba_game_id IN (SELECT r->>'nba_game_id' FROM jsonb_array_elements(p_records) AS r)\n      ORDER BY g.id FOR KEY SHARE;", '    NULL;', concurrency + ['stats']),
        ('L03', ts_path, 'widened retry classification', "['40P01', '40001'].includes(response.error.code)", 'true', unit),
        ('L04', ts_path, 'retry bound off-by-one', 'retry < 3', 'retry < 4', unit),
    ]
    symbol = 'public.resolve_player_imports_atomic(text,jsonb)'
    for mid, relative, operator, original, mutated, oracle in mutations:
        path = root / relative
        source = path.read_text()
        assert source.count(original) == 1, mid
        is_sql = relative == sql_path
        if is_sql:
            definition = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            applied = run('round4-apply-' + mid, psql, source.replace(original, mutated))['exit'] == 0
            deployed = (root / migration).read_text()
            line = deployed[:deployed.index(original)].count('\n') + 1
        else:
            definition = path.read_bytes()
            path.write_text(source.replace(original, mutated))
            applied = True
            line = source[:source.index(original)].count('\n') + 1
        digest = hashlib.sha256(definition).hexdigest()
        outcome = 'invalid'
        checks = []
        try:
            if applied:
                check = run('round4-oracle-' + mid, oracle)
                checks = [check]
                outcome = 'killed' if check['exit'] else 'survived'
        finally:
            if is_sql:
                assert run('round4-restore-' + mid, psql, source)['exit'] == 0
                restored = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            else:
                path.write_text(source)
                restored = path.read_bytes()
            assert hashlib.sha256(restored).hexdigest() == digest
        row = dict(id=mid, area='live-streams', file=migration if is_sql else relative, line=line,
                   symbol=symbol if is_sql else 'resolvePlayerImports', operator=operator, original=original,
                   mutated=mutated, applied=applied, outcome=outcome, oracles=checks,
                   killed_by=[r['name'] for r in checks if r['exit']], notes='Actual deployed SQL or imported runtime TS. Restore SHA256: ' + digest)
        if outcome == 'survived':
            row['notes'] += '; classification: missing assertion; investigate before completion'
        with (evidence / 'results.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        assert outcome == 'killed', row
    for name, command in [('optimizer', concurrency + ['optimizer']), ('stats', concurrency + ['stats']), ('retry', unit)]:
        assert run('round4-mutation-restored-' + name, command)['exit'] == 0
