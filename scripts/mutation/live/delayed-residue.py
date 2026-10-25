import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse
import uuid

for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback stack is allowed')
if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
    raise SystemExit('Residue checks run only in the assigned mini copy')
evidence = Path('../evidence/round7').resolve()
ids = [str(uuid.uuid4()), str(uuid.uuid4())]
quoted = ','.join("'" + value + "'" for value in ids)


def sql(statement):
    result = subprocess.run(['psql', os.environ['SUPABASE_DB_URL'], '-XqAt', '--set', 'ON_ERROR_STOP=1'],
                            input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return result.stdout.strip()


def snapshot():
    return sql(f"SELECT json_agg(row_to_json(game) ORDER BY id) FROM nba_games game WHERE id IN ({quoted})")


try:
    sql('BEGIN; ' + '; '.join(
        f"INSERT INTO nba_games(id,nba_game_id,game_date,season_year,week_number,home_team,away_team,status,game_time) "
        f"VALUES('{game}','002{game.replace('-', '')}',(now() AT TIME ZONE 'America/New_York')::date,2026,1,'BOS','MIA','{status}',now()-interval '11 minutes')"
        for game, status in zip(ids, ['InProgress', 'Scheduled'])) + '; COMMIT;')
    before = snapshot()
    assert sql(f'SELECT count(*) FROM get_live_poll_work() WHERE id IN ({quoted})') == '2'
    for attempt in [1, 2]:
        subprocess.run(['python3', 'scripts/mutation/live/record.py', '--evidence', str(evidence),
                        '--name', f'residue-green-{attempt}', 'npm', 'run', 'test:db:live-poll-delayed-tipoff'], check=True)
        assert snapshot() == before, 'Unrelated committed residue changes'
    (evidence / 'residue.json').write_text(json.dumps(dict(provenance='SYNTHETIC', ids=ids,
        statuses=['InProgress', 'Scheduled'], own_work_rows=2, passes=2,
        unchanged_sha256=hashlib.sha256(before.encode()).hexdigest()), indent=2) + '\n')
finally:
    sql(f'DELETE FROM nba_games WHERE id IN ({quoted})')
    assert sql(f'SELECT count(*) FROM nba_games WHERE id IN ({quoted})') == '0'
