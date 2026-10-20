import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from urllib.parse import urlparse


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def execute(command, timeout=120, source=None):
    started = time.monotonic()
    process = subprocess.Popen(command, shell=True, executable='/bin/bash', stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = process.communicate(source.encode() if source is not None else None, timeout=timeout)
        code = process.returncode
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        code = 124
    return code, round(time.monotonic() - started, 3), output.decode(errors='replace')


def sql(statement):
    code, _, output = execute('psql "$SUPABASE_DB_URL" -XqAt --set ON_ERROR_STOP=1', source=statement)
    if code:
        raise RuntimeError(output)
    return output.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=['baseline', 'tier1', 'strengthened'], required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--ids')
    parser.add_argument('--extra')
    args = parser.parse_args()
    endpoint = urlparse(os.environ['SUPABASE_DB_URL'])
    if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != 57322:
        raise SystemExit('Only the assigned loopback database is allowed')
    api = urlparse(os.environ['SUPABASE_URL'])
    if api.hostname not in ('127.0.0.1', 'localhost') or api.port != 57321:
        raise SystemExit('Only the assigned loopback API is allowed')
    if '/pancake-t_4ba51e0d/lanes/live/' not in str(Path.cwd()):
        raise SystemExit('Mutations run only inside the assigned mini copy')
    os.environ.update(PANCAKE_TEST_API_PORT='57321', PANCAKE_TEST_DB_PORT='57322')
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(Path('scripts/mutation/live/catalog.json').read_text())
    selected = [m for m in catalog if not args.ids or m['id'] in args.ids.split(',')]
    green = evidence / 'baseline-green.log'
    manifest = evidence / 'baseline-commands.json'
    if args.phase == 'baseline':
        commands = dict.fromkeys(o for m in selected for o in m['oracles'])
        if args.extra:
            commands[args.extra] = None
        with green.open('a') as log:
            for command in commands:
                code, seconds, output = execute(command)
                log.write(f'$ {command}\n{output}\nexit={code} seconds={seconds}\n')
                log.flush()
                print(f'baseline exit={code} {command}', flush=True)
                if code:
                    raise SystemExit(code)
        passed = json.loads(manifest.read_text()) if manifest.exists() else []
        manifest.write_text(json.dumps(sorted(set(passed) | set(commands)), indent=2))
        return
    if not green.exists() or not manifest.exists():
        raise SystemExit('Run baseline first')
    passed = json.loads(manifest.read_text())
    if any(command not in passed for mutant in selected for command in mutant['oracles'] + ([args.extra] if args.extra else [])):
        raise SystemExit('Every exact oracle command must pass baseline first')
    for mutant in selected:
        row = {k: mutant[k] for k in ('id', 'area', 'file', 'line', 'symbol', 'operator', 'original', 'mutated')}
        row.update(applied=False, outcome='invalid', oracles=[], killed_by=[], notes=f'phase={args.phase}; input=SYNTHETIC')
        original = None
        is_sql = mutant['file'].endswith('.sql')
        try:
            if is_sql:
                symbol = mutant['symbol'].replace("'", "''")
                original = sql(f"SELECT pg_get_functiondef('{symbol}'::regprocedure)")
            else:
                original = Path(mutant['file']).read_text()
            if original.count(mutant['original']) != 1:
                raise RuntimeError('Expected exactly one original fragment')
            mutated = original.replace(mutant['original'], mutant['mutated'])
            if is_sql:
                sql(mutated)
            else:
                Path(mutant['file']).write_text(mutated)
            row['applied'] = True
            for index, command in enumerate(mutant['oracles'] + ([args.extra] if args.extra else [])):
                code, seconds, output = execute(command)
                path = evidence / f'{args.phase}-{mutant["id"]}-{index}.log'
                path.write_text(f'$ {command}\n{output}\nexit={code} seconds={seconds}\n')
                row['oracles'].append(dict(name=command, command=command, exit=code, seconds=seconds, log=str(path)))
                if code:
                    if code == 124:
                        row['outcome'] = 'timeout'
                    elif 'TS' in output and ('error TS' in output or 'Type checking failed' in output):
                        row['outcome'] = 'invalid'
                    else:
                        row['outcome'] = 'killed'
                        row['killed_by'].append(command)
                    break
            else:
                row['outcome'] = 'survived'
        except Exception as error:
            row['notes'] += '; ' + str(error)
        finally:
            if original is not None:
                if is_sql:
                    sql(original)
                    restored = sql(f"SELECT pg_get_functiondef('{symbol}'::regprocedure)")
                else:
                    Path(mutant['file']).write_text(original)
                    restored = Path(mutant['file']).read_text()
                if digest(restored) != digest(original):
                    raise RuntimeError('Restored definition hash differs; stop before another mutation')
                row['notes'] += '; revert_sha256=' + digest(restored)
            with (evidence / 'results.jsonl').open('a') as output:
                output.write(json.dumps(row) + '\n')
        print(f'{mutant["id"]}: {row["outcome"]}', flush=True)


if __name__ == '__main__':
    main()
