"""Turn-10 current-head mutation reruns (common-t10 protocol) on the claude-live mini copy.

  relabel   recompute killed-row reasons from saved logs
  scan      compare every SQL catalog target's deployed definition with its prior restore hash
  baseline  run each selected oracle unmutated once and record its exit
  mutate    apply, run oracles, classify, restore and hash-verify each selected mutant
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.parse import urlparse

GUARD_LINES = ('Only own local services receive requests', 'Refuse a target outside loopback', 'Only the assigned loopback')
ANSI = re.compile(r'\x1b\[[0-9;]*m')
# Most specific evidence first: assertion messages, SQL errors, failing deno tests, then any error line.
FAILURES = [re.compile(pattern) for pattern in (r'AssertionError.*', r'ERROR: .*', r'^\S.* => \./\S+:\d+:\d+$', r'^error: .*', r'^FAILED .*')]


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


def definition(symbol):
    return sql(f"SELECT pg_get_functiondef('{symbol.replace(chr(39), chr(39) * 2)}'::regprocedure)")


def reason(output):
    lines = [ANSI.sub('', line).strip() for line in output.splitlines()]
    found = []
    for pattern in FAILURES:
        found += [match.group(0) for line in lines for match in [pattern.search(line)] if match and match.group(0) not in found]
    if found:
        return ' | '.join(found[:4])[:600]
    return next((line for line in reversed(lines) if line), 'no output')[:600]


def classify(code, output):
    if code == 124:
        return 'timeout', 'oracle exceeded its timeout'
    if 'error TS' in output or 'Type checking failed' in output:
        return 'invalid', 'compile error: ' + reason(output)
    if any(line in output for line in GUARD_LINES):
        return 'invalid', 'harness guard: ' + reason(output)
    return 'killed', reason(output)


def guard():
    for key, port in (('SUPABASE_DB_URL', 57322), ('SUPABASE_URL', 57321)):
        endpoint = urlparse(os.environ[key])
        if endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.port != port:
            raise SystemExit('Only the assigned loopback stack is allowed')
    if '/pancake-t_4ba51e0d/lanes/claude-live/' not in str(Path.cwd()) + '/':
        raise SystemExit('Mutations run only inside the claude-live mini copy')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=['scan', 'baseline', 'mutate', 'relabel'], required=True)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--ids')
    parser.add_argument('--prior')
    args = parser.parse_args()
    guard()
    evidence = Path(args.evidence).resolve()
    (evidence / 'logs').mkdir(parents=True, exist_ok=True)
    if args.phase == 'scan':
        catalog = json.loads(Path('scripts/mutation/live/catalog.json').read_text())
        restored = {}
        for line in Path(args.prior).read_text().splitlines():
            row = json.loads(line)
            match = re.search(r'revert_sha256=([0-9a-f]{64})', row.get('notes', ''))
            if match:
                restored[row['id']] = match.group(1)
        report = []
        for mutant in catalog:
            if not mutant['file'].endswith('.sql'):
                continue
            current = digest(definition(mutant['symbol']))
            report.append(dict(id=mutant['id'], symbol=mutant['symbol'], prior_sha256=restored.get(mutant['id']), current_sha256=current,
                               changed=restored.get(mutant['id']) != current, fragment_count=definition(mutant['symbol']).count(mutant['original'])))
        (evidence / 'sql-scan.json').write_text(json.dumps(report, indent=2) + '\n')
        for row in report:
            print(row['id'], 'CHANGED' if row['changed'] else 'SAME', row['fragment_count'], flush=True)
        return
    catalog = json.loads(Path('scripts/mutation/live/t10-catalog.json').read_text())
    selected = [m for m in catalog if not args.ids or m['id'] in args.ids.split(',')]
    baseline_path = evidence / 'baseline.json'
    baselines = json.loads(baseline_path.read_text()) if baseline_path.exists() else {}
    if args.phase == 'baseline':
        for command in dict.fromkeys(o for m in selected for o in m['oracles']):
            timeout = max(m.get('timeout', 180) for m in selected if command in m['oracles'])
            code, seconds, output = execute(command, timeout)
            log = f'logs/baseline-{digest(command)[:12]}.log'
            (evidence / log).write_text(f'$ {command}\n{output}\nexit={code} seconds={seconds}\n')
            baselines[command] = dict(exit=code, seconds=seconds, log=log)
            baseline_path.write_text(json.dumps(baselines, indent=2) + '\n')
            print(f'baseline exit={code} seconds={seconds} {command}', flush=True)
        return
    if args.phase == 'relabel':
        # Recompute killed-row reasons from the saved oracle logs.
        results = [json.loads(line) for line in (evidence / 'results.jsonl').read_text().splitlines()]
        for row in results:
            if row['outcome'] == 'killed':
                row['outcome'], row['reason'] = classify(row['mutant_exit'], (evidence / row['log']).read_text())
        (evidence / 'results.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in results))
        return
    for mutant in selected:
        if any(baselines.get(command, {}).get('exit') != 0 for command in mutant['oracles']):
            raise SystemExit(f'{mutant["id"]}: every oracle must pass its unmutated baseline first')
    for mutant in selected:
        row = {key: mutant.get(key) for key in ('id', 'area', 'file', 'line', 'symbol', 'operator', 'original', 'mutated', 'base_sha', 'prior_sha', 'prior_outcome')}
        row.update(lane='live', applied=False, outcome='invalid', reason='', oracle_kind=mutant['oracle_kind'], oracle_cmds=mutant['oracles'],
                   baseline_exit=max(baselines[command]['exit'] for command in mutant['oracles']), mutant_exit=None, seconds=0.0,
                   log=f'logs/{mutant["id"]}.log', restore_sha256=None, input='SYNTHETIC')
        is_sql = mutant['file'].endswith('.sql')
        original = None
        transcript = []
        try:
            original = definition(mutant['symbol']) if is_sql else Path(mutant['file']).read_text()
            count = original.count(mutant['original'])
            if count != 1:
                original = None
                row['reason'] = 'target-removed' if count == 0 else f'fragment occurs {count} times'
                continue
            mutated = original.replace(mutant['original'], mutant['mutated'])
            if is_sql:
                sql(mutated)
            else:
                Path(mutant['file']).write_text(mutated)
            row['applied'] = True
            for command in mutant['oracles']:
                code, seconds, output = execute(command, mutant.get('timeout', 180))
                transcript.append(f'$ {command}\n{output}\nexit={code} seconds={seconds}\n')
                row['seconds'] = round(row['seconds'] + seconds, 3)
                row['mutant_exit'] = code
                if code:
                    row['outcome'], row['reason'] = classify(code, output)
                    break
            else:
                row['outcome'], row['reason'] = 'survived', 'every oracle passed with the mutant applied'
        except Exception as error:
            row['reason'] = f'harness: {error}'[:600]
        finally:
            if original is not None:
                if is_sql:
                    sql(original)
                    restored = definition(mutant['symbol'])
                else:
                    Path(mutant['file']).write_text(original)
                    restored = Path(mutant['file']).read_text()
                if digest(restored) != digest(original):
                    raise RuntimeError(f'{mutant["id"]}: restored definition hash differs; stop before another mutation')
                row['restore_sha256'] = digest(restored)
            (evidence / row['log']).write_text(''.join(transcript) or row['reason'] + '\n')
            with (evidence / 'results.jsonl').open('a') as output:
                output.write(json.dumps(row) + '\n')
        print(f'{mutant["id"]}: {row["outcome"]} exit={row["mutant_exit"]} {row["seconds"]}s {row["reason"][:160]}', flush=True)


if __name__ == '__main__':
    main()
