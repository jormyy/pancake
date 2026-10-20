import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

db = os.environ['SUPABASE_DB_URL']
url = urlparse(db)
if url.hostname not in ('127.0.0.1','localhost') or url.port != 57622:
    raise SystemExit('Refuse a database outside the isolated stack')
root = Path(__file__).resolve().parents[3]
if '/pancake-t_4ba51e0d/lanes/waiv/' not in str(root):
    raise SystemExit('Database recipes run only on the mini')
evidence = Path(sys.argv[1]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
recipes = [
    ['matrix', ['node','tests/e2e/waiver-season-db.mjs']],
    ['http-worker', ['node','tests/e2e/faab-worker-db.mjs']],
    ['backlog', ['node','tests/e2e/waiver-backlog-db.mjs']],
    ['preference-concurrency', ['node','tests/e2e/waiver-preference-concurrency-db.mjs']],
    ['preference-edit-concurrency', ['node','tests/e2e/waiver-preference-concurrency-db.mjs','--edit']],
    ['editor-concurrency', ['node','tests/e2e/waiver-editor-concurrency-db.mjs']],
    ['status-read', ['node','tests/e2e/waiver-status-read-db.mjs']],
    ['trade-waiver-concurrency', ['node','tests/e2e/trade-waiver-concurrency-db.mjs']],
    ['trade-waiver-cross-league', ['node','tests/e2e/trade-waiver-cross-league-db.mjs']],
]
for name, path in [
    ['edit-gates','tests/db/waiver-claim-edit-gates.sql'],
    ['projection','tests/db/waiver-claim-projection.sql'],
    ['rollover-voided-standings','tests/db/dynasty-rules.sql'],
    ['roster-lifecycle','tests/db/roster-lifecycle-invariants.sql'],
    ['cron-catchup','tests/db/cron-dispatch-catchup.sql'],
]:
    recipes.append([name,['psql',db,'-X','-v','ON_ERROR_STOP=1','-f',path]])
failed = False
for name, command in recipes:
    start = time.monotonic()
    try:
        result = subprocess.run(command,cwd=root,text=True,capture_output=True,timeout=150)
        code, output = result.returncode, result.stdout+result.stderr
    except subprocess.TimeoutExpired as error:
        code, output = 124,str(error)
    log = evidence / f'verify-{name}.log'
    log.write_text(output)
    recorded_command = shlex.join(['$SUPABASE_DB_URL' if part==db else part for part in command]).replace("'$SUPABASE_DB_URL'", '"$SUPABASE_DB_URL"')
    row = dict(name=name,command=recorded_command,
               exit=code,seconds=round(time.monotonic()-start,3),log=str(log))
    with (evidence/'verification.jsonl').open('a') as out:
        out.write(json.dumps(row)+'\n')
    print(f'{name}: exit={code}',flush=True)
    failed = failed or code != 0
raise SystemExit(1 if failed else 0)
