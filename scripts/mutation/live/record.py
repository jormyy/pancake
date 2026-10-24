import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--name', required=True)
parser.add_argument('--expect', type=int, default=0)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
result = subprocess.run(args.command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
seconds = round(time.monotonic() - started, 3)
log = args.evidence.resolve() / (args.name + '.log')
log.write_text('$ ' + ' '.join(args.command) + '\n' + result.stdout + f'\nexit={result.returncode} seconds={seconds}\n')
row = dict(name=args.name, command=args.command, exit=result.returncode, seconds=seconds, log=str(log))
with (args.evidence / 'commands.jsonl').open('a') as output:
    output.write(json.dumps(row) + '\n')
print(json.dumps(row), flush=True)
raise SystemExit(0 if result.returncode == args.expect else 1)
