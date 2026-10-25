import re

oracle_first = psql + ['-f', 'tests/db/identity-first-box.sql']
oracle_merge = psql + ['-f', 'tests/db/identity-merge-support.sql']
oracle_claim = psql + ['-f', 'tests/db/player-identity-claim.sql']
oracle_trade = psql + ['-f', 'tests/db/identity-nba-trade-locks.sql']
mutants = [
    ('R01', 'rookie-identity', 'public/resolve_player_imports_atomic.sql', 'resolve_player_imports_atomic', 'removed assignment',
     'UPDATE players SET nba_id = v_provider WHERE id = v_id', 'UPDATE players SET nba_id = nba_id WHERE id = v_id', oracle_first),
    ('R02', 'rookie-identity', 'public/resolve_player_imports_atomic.sql', 'resolve_player_imports_atomic', 'off-by-one constant',
     'nba_draft_number = v_pick,', 'nba_draft_number = v_pick + 1,', oracle_first),
    ('R03', 'rookie-identity', 'public/assign_player_nba_id_atomic.sql', 'assign_player_nba_id_atomic', 'removed assignment',
     'UPDATE players SET nba_id = p_nba_id WHERE id = p_player_id;', 'UPDATE players SET nba_id = nba_id WHERE id = p_player_id;', oracle_claim),
    ('R04', 'rookie-identity', 'public/merge_players.sql', 'merge_players', 'removed statement',
     'UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;', '', oracle_merge),
    ('R05', 'rookie-identity', 'public/merge_players.sql', 'merge_players', 'removed statement',
     'UPDATE fantasypros_projection_rows SET player_id = winner_id WHERE player_id = loser_id;', '', oracle_merge),
    ('T01', 'nba-trades', 'private/lineup_game_started.sql', 'lineup_game_started', 'negate condition',
     'AND NOT EXISTS (', 'AND EXISTS (', oracle_trade),
    ('T02', 'nba-trades', 'private/roster_status_game_started.sql', 'roster_status_game_started', 'removed predicate',
     "OR EXISTS (\n          SELECT 1 FROM player_game_stats AS stats\n          WHERE stats.player_id = p.id AND stats.game_id = g.id\n        )", 'OR FALSE', oracle_trade),
    ('T03', 'nba-trades', 'private/lineup_game_started.sql', 'lineup_game_started', 'relational <= to >',
     'g.game_time <= now()', 'g.game_time > now()', oracle_trade),
]
for label, command in [('first-box', oracle_first), ('merge-support', oracle_merge), ('identity-claim', oracle_claim), ('trade-locks', oracle_trade)]:
    assert run('mutation-baseline-' + label, command)['exit'] == 0
for mid, area, relative, symbol, operator, original, mutated, oracle in mutants:
    path = root / 'supabase/sql/functions/by-name' / relative
    source = path.read_text()
    assert source.count(original) == 1, (mid, source.count(original))
    schema = relative.split('/')[0]
    signature = dict(resolve_player_imports_atomic='text,jsonb', merge_players='uuid,uuid',
                     assign_player_nba_id_atomic='uuid,text', lineup_game_started='uuid,date',
                     roster_status_game_started='uuid')[symbol]
    identity = schema + '.' + symbol + '(' + signature + ')'
    definition = subprocess.check_output(psql + ['-c', "SELECT pg_get_functiondef('" + identity + "'::regprocedure)"], env=env)
    digest = hashlib.sha256(definition).hexdigest()
    latest = None
    line = None
    for migration in sorted((root / 'supabase/migrations').glob('*.sql')):
        statement = migration.read_text()
        match = re.search(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:' + schema + r'\.)?' + symbol + r'\s*\(', statement, re.I)
        if match:
            latest = migration
            position = statement.find(original, match.start())
            line = statement[:position if position >= 0 else match.start()].count('\n') + 1
    assert latest and line
    applied = run('apply-' + mid, psql, source.replace(original, mutated))
    outcome = 'invalid'
    checks = []
    try:
        if applied['exit'] == 0:
            check = run('oracle-' + mid, oracle)
            checks = [{key: check[key] for key in ['name', 'command', 'exit', 'seconds', 'log']}]
            outcome = 'killed' if check['exit'] != 0 else 'survived'
    finally:
        assert run('restore-' + mid, psql, source)['exit'] == 0
        restored = subprocess.check_output(psql + ['-c', "SELECT pg_get_functiondef('" + identity + "'::regprocedure)"], env=env)
        assert hashlib.sha256(restored).hexdigest() == digest
    row = dict(id=mid, area=area, file=str(latest.relative_to(root)), line=line, symbol=identity,
               operator=operator, original=original, mutated=mutated, applied=applied['exit'] == 0,
               outcome=outcome, oracles=checks, killed_by=[check['name'] for check in checks if check['exit'] != 0],
               notes='Deployed SQL overlay; pg_get_functiondef SHA256 restored: ' + digest)
    if outcome == 'survived':
        row['notes'] += '; classification: missing assertion; needs investigation'
    with (evidence / 'results.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    print(json.dumps(dict(id=mid, outcome=outcome)), flush=True)
for label, command in [('first-box', oracle_first), ('merge-support', oracle_merge), ('identity-claim', oracle_claim), ('trade-locks', oracle_trade)]:
    assert run('mutation-restored-' + label, command)['exit'] == 0
