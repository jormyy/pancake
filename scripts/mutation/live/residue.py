import argparse
import hashlib
import json
import os
import shlex
from pathlib import Path
import subprocess
import time
from urllib.parse import urlparse
import uuid


parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['seed', 'red', 'green', 'verify', 'cleanup'], required=True)
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
for key, port in [('SUPABASE_URL', 57321), ('SUPABASE_DB_URL', 57322)]:
    endpoint = urlparse(os.environ[key])
    if endpoint.hostname not in ('localhost', '127.0.0.1') or endpoint.port != port:
        raise SystemExit('Only the assigned loopback stack is allowed')
if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
    raise SystemExit('Residue checks run only in the assigned mini copy')
evidence = Path(args.evidence).resolve()
evidence.mkdir(parents=True, exist_ok=True)
manifest = evidence / 'fixture.json'
commands = evidence / 'commands.jsonl'


def run(name, command, expected=0, message=None):
    started = time.monotonic()
    result = subprocess.run(command, shell=True, executable='/bin/bash', text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    log = evidence / f'{name}.log'
    seconds = round(time.monotonic() - started, 3)
    log.write_text(f'$ {command}\n{result.stdout}\nexit={result.returncode} seconds={seconds}\n')
    row = dict(name=name, command=command, exit=result.returncode, expected=expected, seconds=seconds, log=str(log))
    with commands.open('a') as output:
        output.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)
    assert result.returncode == expected and (message is None or message in result.stdout), log


def sql(statement):
    result = subprocess.run(['psql', os.environ['SUPABASE_DB_URL'], '-XqAt', '--set', 'ON_ERROR_STOP=1'],
                            input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def ids(values):
    return ','.join(quote(value) for value in values)


if args.phase == 'seed':
    assert not manifest.exists(), 'Use a new evidence directory for a new fixture'
    assert sql("SELECT prosrc FROM pg_proc WHERE oid='pg_catalog.clock_timestamp()'::regprocedure") == 'clock_timestamp'
    fixture = {key: str(uuid.uuid4()) for key in ['league', 'season', 'holder', 'invocation']}
    for key, count in [('users', 2), ('members', 2), ('games', 2), ('weeks', 9)]:
        fixture[key] = [str(uuid.uuid4()) for _ in range(count)]
    assert sql('SELECT count(*) FROM season_weeks WHERE season_year IN (8993,9395,9599,9101)') == '0'
    league, season = fixture['league'], fixture['season']
    users, members, games, weeks = (fixture[key] for key in ['users', 'members', 'games', 'weeks'])
    sql(f"""BEGIN;
      INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
        VALUES({quote(users[0])},'authenticated','authenticated',{quote(users[0]+'@example.test')},'{{}}','{{}}'),
          ({quote(users[1])},'authenticated','authenticated',{quote(users[1]+'@example.test')},'{{}}','{{}}');
      INSERT INTO leagues(id,name,slug,commissioner_id,status,scoring_settings)
        VALUES({quote(league)},'Synthetic committed live residue',{quote(league)},{quote(users[0])},'active','{{"points":1}}');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES({quote(season)},{quote(league)},8993,true);
      INSERT INTO league_members(id,league_id,user_id,role,team_name)
        VALUES({quote(members[0])},{quote(league)},{quote(users[0])},'commissioner','Home'),
          ({quote(members[1])},{quote(league)},{quote(users[1])},'manager','Away');
      INSERT INTO season_weeks(id,season_year,week_number,week_start,week_end)
        SELECT seed.id::uuid,seed.year,seed.week,
          (now() AT TIME ZONE 'America/New_York')::date+seed.day_offset,
          (now() AT TIME ZONE 'America/New_York')::date+seed.day_offset+6
        FROM (VALUES
          ({quote(weeks[0])},8993,1,-15),({quote(weeks[1])},8993,2,-8),({quote(weeks[2])},8993,3,-1),
          ({quote(weeks[3])},9395,1,-15),({quote(weeks[4])},9395,2,-8),({quote(weeks[5])},9395,3,-1),
          ({quote(weeks[6])},9395,4,6),({quote(weeks[7])},9599,1,-15),({quote(weeks[8])},9101,1,-1)
        ) seed(id,year,week,day_offset);
      INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
        VALUES({quote(games[0])},{quote('002-residue-'+games[0])},8993,3,(now() AT TIME ZONE 'America/New_York')::date,'BOS','MIA','InProgress'),
          ({quote(games[1])},{quote('002-residue-'+games[1])},8993,3,(now() AT TIME ZONE 'America/New_York')::date-1,'BOS','MIA','Final');
      INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,is_finalized,
          finalized_at,home_points,away_points,home_max_possible_points,away_max_possible_points,winner_member_id)
        VALUES({quote(league)},{quote(season)},1,{quote(members[0])},{quote(members[1])},'regular_season',true,
          now()-interval '9 days',3,2,3,2,{quote(members[0])});
      INSERT INTO private.score_week_certificates(league_season_id,week_number,input_token)
        VALUES({quote(season)},1,capture_score_inputs({quote(season)},1));
      UPDATE leagues SET scoring_settings='{{"points":2}}' WHERE id={quote(league)};
      INSERT INTO live_poll_leases(lock_key,holder_id,acquired_at,expires_at)
        VALUES(779001,{quote(fixture['holder'])},now(),now()+interval '1 day');
      INSERT INTO edge_invocations(function_name,invocation_key,queued_at)
        VALUES('sync-scores',{quote(fixture['invocation'])},now()+interval '1 day');
      COMMIT;""")
    manifest.write_text(json.dumps(fixture, indent=2) + '\n')
else:
    fixture = json.loads(manifest.read_text())


def snapshot():
    league, season = quote(fixture['league']), quote(fixture['season'])
    return sql(f"""SELECT jsonb_build_object(
      'leagues',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM leagues item WHERE id={league}),
      'seasons',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM league_seasons item WHERE id={season}),
      'members',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM league_members item WHERE league_id={league}),
      'games',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM nba_games item WHERE id IN ({ids(fixture['games'])})),
      'weeks',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM season_weeks item WHERE id IN ({ids(fixture['weeks'])})),
      'matchups',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM matchups item WHERE league_id={league}),
      'certificates',(SELECT jsonb_agg(to_jsonb(item) ORDER BY week_number) FROM private.score_week_certificates item WHERE league_season_id={season}),
      'leases',(SELECT jsonb_agg(to_jsonb(item)) FROM live_poll_leases item WHERE holder_id={quote(fixture['holder'])}),
      'invocations',(SELECT jsonb_agg(to_jsonb(item)) FROM edge_invocations item WHERE invocation_key={quote(fixture['invocation'])}),
      'live_work',(SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM get_live_poll_work() item WHERE id IN ({ids(fixture['games'])})),
      'stale_weeks',(SELECT jsonb_agg(week_number ORDER BY week_number) FROM get_stale_score_weeks({season},1)))""")


current = snapshot()
if args.phase == 'seed':
    measured = json.loads(current)
    assert len(measured['live_work']) == 2 and measured['stale_weeks'] == [1]
    (evidence / 'residue-before.json').write_text(current + '\n')
    print('Committed SYNTHETIC active league, stale closed week, two live-work games, calendars, lease and invocation')
else:
    assert current == (evidence / 'residue-before.json').read_text().strip(), 'Committed residue changed'
    if args.phase == 'red':
        for name, message in [('weekly-idle-dispatch', 'requires an idle local stack'),
                              ('weekly-skip-idle', 'requires an idle stack'),
                              ('live-score-guards', 'duplicate key value')]:
            path = evidence / f'before-{name}.sql'
            run(f'red-{name}', 'psql "$SUPABASE_DB_URL" -X --set ON_ERROR_STOP=1 -f ' + shlex.quote(str(path)), 3, message)
    elif args.phase == 'green':
        for iteration in [1, 2]:
            for name in ['weekly-idle-dispatch', 'weekly-formula-boundaries', 'live-score-guards', 'live-score-overlap', 'weekly-skip-idle']:
                run(f'pass{iteration}-{name}', 'npm run test:db:' + name)
                assert snapshot() == current, f'{name} changed committed residue'
        (evidence / 'residue-after-chain.json').write_text(snapshot() + '\n')
    elif args.phase == 'verify':
        (evidence / 'residue-after-mutations.json').write_text(current + '\n')
    elif args.phase == 'cleanup':
        sql(f"""BEGIN;
          DELETE FROM edge_invocations WHERE invocation_key={quote(fixture['invocation'])};
          DELETE FROM live_poll_leases WHERE lock_key=779001 AND holder_id={quote(fixture['holder'])};
          DELETE FROM leagues WHERE id={quote(fixture['league'])};
          DELETE FROM nba_games WHERE id IN ({ids(fixture['games'])});
          DELETE FROM season_weeks WHERE id IN ({ids(fixture['weeks'])});
          DELETE FROM profiles WHERE id IN ({ids(fixture['users'])});
          DELETE FROM auth.users WHERE id IN ({ids(fixture['users'])});
          COMMIT;""")
        assert sql(f'SELECT count(*) FROM leagues WHERE id={quote(fixture["league"])}') == '0'
        assert sql(f'SELECT count(*) FROM nba_games WHERE id IN ({ids(fixture["games"])})') == '0'
        (evidence / 'cleanup.log').write_text('Only identified synthetic residue deleted; league and game counts are zero\n')
        print('Removed only the identified SYNTHETIC residue')
    assert args.phase == 'cleanup' or snapshot() == current
    (evidence / f'{args.phase}-snapshot.sha256').write_text(hashlib.sha256(current.encode()).hexdigest() + '\n')
