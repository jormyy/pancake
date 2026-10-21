import argparse
from pathlib import Path

exec(Path(__file__).with_name('run.py').read_text().split('parser = argparse.ArgumentParser()', 1)[0])
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['checks', 'mutations'])
args = parser.parse_args()
oracle = deno + ['supabase/tests/db/identity-game-membership.ts']
if args.mode == 'checks':
    files = ['supabase/functions/_shared/playerResolver.ts', 'supabase/functions/_shared/syncStats.ts',
             'supabase/tests/db/identity-game-membership.ts']
    commands = [
        ('round3-db-sources', ['node', 'scripts/check-db-function-sources.mjs', '--check']),
        ('round3-edge-shared', ['node', 'scripts/generate-edge-shared.mjs', '--check']),
        ('round3-edge-functions', ['npm', 'run', 'check:edge-functions']),
        ('round3-typecheck-e2e', ['npm', 'run', 'typecheck:e2e']),
        ('round3-eslint', ['npx', 'eslint', *files, '--max-warnings=0']),
        ('round3-deno-check', ['deno', 'check', '--no-lock', *files]),
        ('round3-deno-tests', ['deno', 'test', '--no-lock', '--allow-env', '--allow-net', '--allow-read',
                              'supabase/functions/_shared/playerResolver.test.ts',
                              'supabase/functions/_shared/syncStats.test.ts',
                              'supabase/functions/_shared/syncStats.concurrency.test.ts',
                              'supabase/functions/_shared/syncStats.contention.test.ts',
                              'supabase/functions/_shared/cdnBatch.test.ts',
                              'supabase/functions/sync-players/imports.test.ts']),
        ('round3-source-observability', ['npx', 'vitest', 'run', 'tests/e2e-source-observability-contract.test.ts']),
        ('round3-knip-default', ['npx', 'knip', '--no-progress', '--no-config-hints']),
    ]
    failed = []
    for label, command in commands:
        if run(label, command)['exit']:
            failed.append(label)
    if failed == ['round3-knip-default']:
        config = json.loads((root / 'knip.json').read_text())
        config['workspaces']['.']['entry'].append('supabase/tests/db/identity-game-membership.ts')
        config_path = evidence / 'knip-round3-pending-registration.json'
        config_path.write_text(json.dumps(config, indent=2) + '\n')
        assert run('round3-knip-pending-registration', ['npx', 'knip', '--no-progress', '--no-config-hints', '--config', str(config_path)])['exit'] == 0
    elif failed:
        raise SystemExit('Failed checks: ' + ', '.join(failed))
else:
    assert run('round3-mutation-baseline', oracle)['exit'] == 0
    mutations = [
        ('T04', 'supabase/functions/_shared/syncStats.ts', 'resolveBoxScorePlayers', 'removed argument',
         '  })), providerGameId)', '  })))', None),
        ('T05', 'supabase/sql/functions/by-name/private/roster_status_game_started.sql',
         'private.roster_status_game_started(uuid)', 'removed UNION branch',
         '    UNION\n    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id', '',
         'supabase/migrations/20261020000131_record_verified_player_game_membership.sql'),
    ]
    for mid, relative, symbol, operator, original, mutated, migration in mutations:
        path = root / relative
        source = path.read_text()
        assert source.count(original) == 1
        if migration:
            definition = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            applied = run('round3-apply-' + mid, psql, source.replace(original, mutated))['exit'] == 0
            deployed = (root / migration).read_text()
            start = deployed.index('FUNCTION ' + symbol.split('(')[0])
            line = deployed[:deployed.index(original, start)].count('\n') + 1
        else:
            definition = path.read_bytes()
            path.write_text(source.replace(original, mutated))
            applied = True
            line = source[:source.index(original)].count('\n') + 1
        digest = hashlib.sha256(definition).hexdigest()
        checks = []
        outcome = 'invalid'
        try:
            if applied:
                check = run('round3-oracle-' + mid, oracle)
                checks = [check]
                outcome = 'killed' if check['exit'] else 'survived'
        finally:
            if migration:
                assert run('round3-restore-' + mid, psql, source)['exit'] == 0
                restored = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            else:
                path.write_text(source)
                restored = path.read_bytes()
            assert hashlib.sha256(restored).hexdigest() == digest
        row = dict(id=mid, area='nba-trades', file=migration or relative, line=line, symbol=symbol,
                   operator=operator, original=original, mutated=mutated, applied=applied,
                   outcome=outcome, oracles=checks, killed_by=[r['name'] for r in checks if r['exit']],
                   notes='Actual mini runtime source or deployed SQL overlay; restored SHA256: ' + digest)
        if outcome == 'survived':
            row['notes'] += '; classification: missing assertion; investigate before completion'
        with (evidence / 'results.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        assert outcome == 'killed', row
    assert run('round3-mutation-restored', oracle)['exit'] == 0
