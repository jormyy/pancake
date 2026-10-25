import argparse
from pathlib import Path

exec(Path(__file__).with_name('run.py').read_text().split('parser = argparse.ArgumentParser()', 1)[0])
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['red-rankings', 'green', 'regressions', 'checks', 'mutations'])
args = parser.parse_args()
recipe_deno = ['deno', 'run', '--no-lock', '--check', '--allow-env',
               '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql']
recipes = {name: recipe_deno + ['supabase/tests/db/identity-' + name + '.ts'] for name in ['projections', 'rankings']}
if args.mode == 'red-rankings':
    row = run('t9-red-rankings', recipes['rankings'])
    assert row['exit'] != 0
    assert 'External fetch blocked' in (root / row['log']).read_text()
elif args.mode == 'green':
    for wave in range(1, 3):
        for name, command in recipes.items():
            assert run(f't9-green-{name}-{wave}', command)['exit'] == 0
elif args.mode == 'regressions':
    for name in ['identity-merge-support', 'identity-merge-watches', 'fantasypros-projections', 'dynasty-ranking', 'dynasty-decision-inputs', 'player-imports']:
        assert run('t9-regression-' + name, ['npm', 'run', 'test:db:' + name])['exit'] == 0
    assert run('t9-regression-identity-continuity', deno + ['supabase/tests/db/identity-continuity.ts'])['exit'] == 0
    assert run('t9-unit-rankings-projections', ['deno', 'test', '--no-lock', '--allow-env', '--allow-read', '--allow-net',
        'supabase/functions/sync-rankings/', 'supabase/functions/sync-projections/'])['exit'] == 0
elif args.mode == 'checks':
    files = ['supabase/tests/db/identity-rank-projection-fixture.ts', 'supabase/tests/db/identity-projections.ts',
             'supabase/tests/db/identity-rankings.ts', 'supabase/functions/sync-rankings/index.ts']
    config = json.loads((root / 'knip.json').read_text())
    config['workspaces']['.']['entry'] += ['supabase/tests/db/identity-projections.ts', 'supabase/tests/db/identity-rankings.ts']
    config_path = evidence / 'knip-t9-proposed.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    commands = [
        ('t9-eslint', ['npx', 'eslint', *files, '--max-warnings=0']),
        ('t9-deno-check', ['deno', 'check', '--no-lock', *files]),
        ('t9-db-sources', ['node', 'scripts/check-db-function-sources.mjs', '--check']),
        ('t9-edge-shared', ['node', 'scripts/generate-edge-shared.mjs', '--check']),
        ('t9-db-function-catalog', ['npm', 'run', 'check:db-function-catalog']),
        ('t9-database-types', ['npm', 'run', 'check:database-types']),
        ('t9-edge-functions', ['npm', 'run', 'check:edge-functions']),
        ('t9-typecheck-e2e', ['npm', 'run', 'typecheck:e2e']),
        ('t9-knip', ['npx', 'knip', '--no-progress', '--no-config-hints', '--config', str(config_path)]),
    ]
    failed = [name for name, command in commands if run(name, command)['exit']]
    assert not failed, failed
else:
    for name, command in recipes.items():
        assert run('t9-mutation-baseline-' + name, command)['exit'] == 0
    merge = 'supabase/sql/functions/by-name/public/merge_players.sql'
    projection = 'supabase/functions/sync-projections/index.ts'
    match = 'supabase/functions/sync-rankings/match.ts'
    mutations = [
        ('P01', projection, 'off-by-one constant', 'const LOOKBACK_WEEKS = 4', 'const LOOKBACK_WEEKS = 3', 'projections'),
        ('P02', projection, 'removed DNP predicate', '    if (stat.did_not_play) continue', '', 'projections'),
        ('P03', merge, 'removed projection transfer', '  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;', '', 'projections'),
        ('P04', merge, 'wrong projection target argument', '  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;', '  UPDATE player_projections SET player_id = loser_id WHERE player_id = loser_id;', 'projections'),
        ('RR01', match, 'removed canonical player link', 'player_id: player?.id ?? null,', 'player_id: null,', 'rankings'),
        ('RR02', match, 'removed name normalization', 'maps.byNormName.get(normalizeName(name))', 'maps.byNormName.get(name.toLowerCase())', 'rankings'),
        ('RR03', match, 'off-by-one rank', 'source_rank: ranking.rank,', 'source_rank: ranking.rank + 1,', 'rankings'),
        ('RR04', match, 'changed movement value', 'rank_change: ranking.rankChange,', 'rank_change: 0,', 'rankings'),
        ('RR05', merge, 'removed ranking transfer', '  UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;', '', 'rankings'),
        ('RR06', merge, 'removed losing rank fallback', 'dynasty_rank = COALESCE(v_winner.dynasty_rank, v_loser.dynasty_rank),', 'dynasty_rank = v_winner.dynasty_rank,', 'rankings'),
    ]
    for mid, relative, operator, original, mutated, name in mutations:
        path = root / relative
        source = path.read_text()
        assert source.count(original) == 1, mid
        is_sql = relative == merge
        symbol = 'public.merge_players(uuid,uuid)' if is_sql else ('syncInternalFallbackProjections' if relative == projection else 'buildDynastyRankingPayload')
        definition = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env) if is_sql else path.read_bytes()
        digest = hashlib.sha256(definition).hexdigest()
        applied = True
        if is_sql:
            applied = run('t9-apply-' + mid, psql, source.replace(original, mutated))['exit'] == 0
        else:
            path.write_text(source.replace(original, mutated))
        checks = []
        outcome = 'invalid'
        try:
            if applied:
                check = run('t9-oracle-' + mid, recipes[name])
                checks = [check]
                outcome = 'killed' if check['exit'] else 'survived'
        finally:
            if is_sql:
                assert run('t9-restore-' + mid, psql, source)['exit'] == 0
                restored = subprocess.check_output(psql + ['-c', f"SELECT pg_get_functiondef('{symbol}'::regprocedure)"], env=env)
            else:
                path.write_text(source)
                restored = path.read_bytes()
            assert hashlib.sha256(restored).hexdigest() == digest
        deployed_path = 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql' if is_sql else relative
        deployed = (root / deployed_path).read_text()
        row = dict(id=mid, area='rookie-identity', file=deployed_path, line=deployed[:deployed.index(original)].count('\n') + 1,
                   symbol=symbol, operator=operator, original=original, mutated=mutated, applied=applied, outcome=outcome,
                   oracles=checks, killed_by=[check['name'] for check in checks if check['exit']], notes='Actual runtime TS or deployed SQL. Restore SHA256: ' + digest)
        with (evidence / 'results.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        assert outcome == 'killed', row
    for name, command in recipes.items():
        assert run('t9-mutation-restored-' + name, command)['exit'] == 0
