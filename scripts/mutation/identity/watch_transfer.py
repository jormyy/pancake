import argparse
from pathlib import Path

exec(Path(__file__).with_name('run.py').read_text().split('parser = argparse.ArgumentParser()', 1)[0])
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['red', 'green', 'regressions', 'checks', 'mutations'])
args = parser.parse_args()
recipe = psql + ['-f', 'tests/db/identity-merge-watches.sql']
sql_path = root / 'supabase/sql/functions/by-name/public/merge_players.sql'
migration = 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql'
symbol = 'public.merge_players(uuid,uuid)'

if args.mode == 'red':
    for mode in ['direct', 'import']:
        row = run('watch-red-' + mode, recipe + ['-v', 'identity_watch_path=' + mode])
        assert row['exit'] == 3
        assert mode + ' merge loses watches' in (root / row['log']).read_text()
elif args.mode == 'green':
    for wave in range(1, 3):
        assert run('watch-green-' + str(wave), recipe)['exit'] == 0
elif args.mode == 'regressions':
    for name in ['identity-merge-support', 'sparse-player-merge', 'taxi-merged-history',
                 'player-imports', 'identity-import-concurrency', 'notif-round3']:
        assert run('watch-regression-' + name, ['npm', 'run', 'test:db:' + name])['exit'] == 0
elif args.mode == 'checks':
    commands = [
        ('watch-db-sources', ['node', 'scripts/check-db-function-sources.mjs', '--check']),
        ('watch-edge-shared', ['node', 'scripts/generate-edge-shared.mjs', '--check']),
        ('watch-database-types', ['npm', 'run', 'check:database-types']),
        ('watch-db-function-catalog', ['npm', 'run', 'check:db-function-catalog']),
        ('watch-typecheck-e2e', ['npm', 'run', 'typecheck:e2e']),
        ('watch-edge-functions', ['npm', 'run', 'check:edge-functions']),
        ('watch-knip', ['npx', 'knip', '--no-progress', '--no-config-hints']),
    ]
    failed = [name for name, command in commands if run(name, command)['exit']]
    assert not failed, failed
else:
    source = sql_path.read_text()
    transfer = '''  INSERT INTO player_watches(league_id, member_id, player_id, created_at)
    SELECT league_id, member_id, winner_id, created_at FROM player_watches
    WHERE player_id = loser_id ORDER BY member_id
    ON CONFLICT (member_id, player_id) DO NOTHING;
'''
    conflict = '    ON CONFLICT (member_id, player_id) DO NOTHING;'
    assert run('watch-mutation-baseline', recipe)['exit'] == 0
    for mid, operator, original, mutated in [
        ('W01', 'removed INSERT statement', transfer, ''),
        ('W02', 'removed ON CONFLICT clause', conflict, ';'),
    ]:
        assert source.count(original) == 1
        definition = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
        digest = hashlib.sha256(definition).hexdigest()
        applied = run('watch-apply-' + mid, psql, source.replace(original, mutated))['exit'] == 0
        checks = []
        outcome = 'invalid'
        try:
            if applied:
                row = run('watch-oracle-' + mid, recipe)
                checks = [row]
                outcome = 'killed' if row['exit'] else 'survived'
        finally:
            assert run('watch-restore-' + mid, psql, source)['exit'] == 0
            restored = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            assert hashlib.sha256(restored).hexdigest() == digest
        deployed = (root / migration).read_text()
        row = dict(id=mid, area='rookie-identity', file=migration,
                   line=deployed[:deployed.index(original)].count('\n') + 1,
                   symbol=symbol, operator=operator, original=original, mutated=mutated,
                   applied=applied, outcome=outcome, oracles=checks,
                   killed_by=[check['name'] for check in checks if check['exit']],
                   notes='Deployed SQL overlay. Restored pg_get_functiondef SHA256: ' + digest)
        with (evidence / 'results.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        assert outcome == 'killed', row
    assert run('watch-mutation-restored', recipe)['exit'] == 0
