import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from pathlib import Path
from targets import database_target

parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['initial', 'enhanced', 'worker', 'boundary', 'allstar'], default='initial')
parser.add_argument('--evidence', required=True, type=Path)
parser.add_argument('--ids', default='')
parser.add_argument('--baseline-only', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
db = database_target()
args.evidence.mkdir(parents=True, exist_ok=True)
catalog = json.loads((root / 'scripts/mutation/waivers/catalog.json').read_text())
oracles = catalog['oracles'][args.phase]
env = dict(os.environ, PGOPTIONS='-c statement_timeout=20000 -c lock_timeout=5000')


def sql(statement):
    result = subprocess.run(['psql', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=statement,
                            text=True, capture_output=True, timeout=30, env=env)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.rstrip('\n')


def oracle(name, command, prefix):
    command = [v.replace('{db}', db) for v in command]
    log = args.evidence / f'{prefix}-{name}.log'
    start = time.monotonic()
    try:
        result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True, timeout=65)
        code = result.returncode
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired as error:
        code = 124
        output = str(error)
    log.write_text(output)
    recorded_command = shlex.join(['$SUPABASE_DB_URL' if v == db else v for v in command]).replace("'$SUPABASE_DB_URL'", '"$SUPABASE_DB_URL"')
    return dict(name=name, command=recorded_command,
                exit=code, seconds=round(time.monotonic()-start,3), log=str(log))


baseline = [oracle(name, cmd, f'baseline-{args.phase}') for name, cmd in oracles]
with (args.evidence / 'baseline-green.log').open('a') as log:
    for row in baseline:
        log.write(json.dumps(dict(phase=args.phase, **row))+'\n')
if any(row['exit'] for row in baseline):
    raise SystemExit('Baseline failed; no mutations applied')
if args.baseline_only:
    raise SystemExit(0)
selected = set(args.ids.split(',')) if args.ids else None
output_path = args.evidence / f'{args.phase}-results.jsonl'
for mutant in catalog['mutants']:
    if selected and mutant['id'] not in selected:
        continue
    if mutant.get('retired'):
        row = {k:mutant[k] for k in ('id','area','file','line','symbol','operator','original','mutated')}
        row.update(applied=False, outcome='invalid', oracles=[], killed_by=[], notes=mutant['notes'])
        with output_path.open('a') as log:
            log.write(json.dumps(row)+'\n')
        print(f'{row["id"]}: invalid', flush=True)
        continue
    symbol = mutant['symbol']
    is_file = mutant.get('kind') == 'file'
    source_path = root / mutant['canonical']
    original_definition = source_path.read_text() if is_file else sql(f"SELECT pg_get_functiondef('{symbol}'::regproc);")
    before_hash = hashlib.sha256(original_definition.encode()).hexdigest()
    source = source_path.read_text()
    if not is_file:
        source = source[source.index('CREATE OR REPLACE FUNCTION'):].strip()
    matches = list(re.finditer(re.escape(mutant['original']), source))
    row = {k:mutant[k] for k in ('id','area','file','line','symbol','operator','original','mutated')}
    row.update(applied=False, outcome='invalid', oracles=[], killed_by=[], notes=mutant['notes'])
    try:
        if not is_file:
            sql(source)
            if hashlib.sha256(sql(f"SELECT pg_get_functiondef('{symbol}'::regproc);").encode()).hexdigest() != before_hash:
                raise RuntimeError('Canonical definition differs from migrated database')
        match = matches[mutant['occurrence']]
        changed = source[:match.start()] + mutant['mutated'] + source[match.end():]
        if is_file:
            source_path.write_text(changed)
        else:
            sql(changed)
        row['applied'] = True
        row['oracles'] = [oracle(name, cmd, f'{args.phase}-{mutant["id"]}') for name, cmd in oracles]
        exits = [o['exit'] for o in row['oracles']]
        row['outcome'] = 'timeout' if 124 in exits else 'killed' if any(exits) else 'survived'
        row['killed_by'] = [o['name'] for o in row['oracles'] if o['exit'] not in (0,124)]
    except Exception as error:
        row['notes'] += ' | ' + str(error)
    finally:
        if is_file:
            source_path.write_text(original_definition)
            restored = source_path.read_text()
        else:
            sql(original_definition)
            restored = sql(f"SELECT pg_get_functiondef('{symbol}'::regproc);")
        restored_hash = hashlib.sha256(restored.encode()).hexdigest()
        if restored_hash != before_hash:
            raise SystemExit(f'RESTORE FAILED: {symbol}')
        row['notes'] += f' | restored_sha256={restored_hash}'
    with output_path.open('a') as log:
        log.write(json.dumps(row)+'\n')
    print(f'{row["id"]}: {row["outcome"]}', flush=True)
