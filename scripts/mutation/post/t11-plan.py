#!/usr/bin/env python3
"""Turn-11 follow-up 1 plan: calendar and playoff-fit mutants through the served path.

Run from the repository root on a checkout whose application files equal the base:
  python3 scripts/mutation/post/t11-plan.py <post results.jsonl> <post t10 results.jsonl> <base sha>
It writes scripts/mutation/post/t11-plan.json for rerun-t10.mjs (POST_PLAN). Each
catalog target keeps its original and mutated text and gets the id
post-t11-<catalog id>; its only oracle is a case of the served
post-t11-schedule-http.ts recipe. The prior verdict is the target's latest
non-served row: the turn-11 rerun row when the target changed since its first
measurement, otherwise the first measurement.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

CATALOG = Path('scripts/mutation/post/catalog.json')
PLAN = Path('scripts/mutation/post/t11-plan.json')
RECIPE = 'supabase/tests/db/post-t11-schedule-http.ts'
CASES = {
    **{f'post-t3-{n:02d}': ['calendar'] for n in [1, 2, 3, 4, 6, 7, 8, 10]},
    # Pass 1 survivor: the real schedules have no other gap of two or more days across an NBA week.
    'post-t3-05': ['calendar', 'sunday-gap'],
    'post-t3-09': ['republish'],
    **{f'post-t4-{n:02d}': ['fit'] for n in [5, 6, 7]},
}


def git(*args: str) -> str:
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def definitions(text: str, name: str) -> list[re.Match]:
    schema, fn = name.split('.')
    return list(re.finditer(r'create\s+(?:or\s+replace\s+)?function\s+"?%s"?\."?%s"?\s*\(' % (schema, fn), text, re.I))


def function_statement(text: str, name: str) -> tuple[int, str]:
    match = definitions(text, name)[-1]
    end = text.find('$$;', text.find('$$', match.end()) + 2)
    return match.start(), text[match.start():end + 3]


def main() -> None:
    first = {row['id']: row for row in map(json.loads, Path(sys.argv[1]).read_text().splitlines())}
    rerun = {row['id']: row for row in map(json.loads, Path(sys.argv[2]).read_text().splitlines())}
    base = git('rev-parse', sys.argv[3]).strip()
    head = git('rev-parse', 'HEAD').strip()
    catalog = {entry['id']: entry for entry in json.loads(CATALOG.read_text())}
    migrations = sorted(Path('supabase/migrations').glob('*.sql'))
    oracles = {f'schedule-http-{case}': {'kind': 'edge-http', 'command': f'POST_SCHEDULE_CASE={case} node scripts/mutation/post/check.mjs {RECIPE}'}
               for case in sorted({case for cases in CASES.values() for case in cases})}
    mutants = []
    for catalog_id, cases in CASES.items():
        entry = catalog[catalog_id]
        if entry['file'].endswith('.ts'):
            target, offset = entry['file'], 0
            source = Path(target).read_text()
        else:
            name = entry['symbol'].split('(')[0]
            target = str([path for path in migrations if definitions(path.read_text(), name)][-1])
            offset, source = function_statement(Path(target).read_text(), name)
        subprocess.run(['git', 'diff', '--quiet', base, '--', target], check=True)
        assert source.count(entry['original']) == 1, catalog_id
        line = Path(target).read_text()[:offset + source.find(entry['original'])].count('\n') + 1
        if catalog_id in rerun:
            prior = rerun[catalog_id]
            prior_sha, prior_outcome = prior['base_sha'], prior['outcome']
            note = (f"prior: {catalog_id} turn-11 rerun row ({prior['oracle_kind']}, base {prior_sha[:8]}, {prior_outcome}; "
                    f"first measured at {prior['prior_sha'][:8]}, {prior['prior_outcome']}) via {', '.join(o['name'] for o in prior['oracle_cmds'])}")
        else:
            prior = first[catalog_id]
            if target.endswith('.ts'):
                measured = re.findall(r'Restore SHA-256 verified: ([0-9a-f]{64})', prior['notes'])[-1]
                prior_sha = next(commit for commit in git('rev-list', head, '--', target).split()
                                 if sha(subprocess.run(['git', 'show', f'{commit}:{target}'], capture_output=True).stdout) == measured)
            else:
                prior_sha = git('log', '--reverse', '--format=%H', '-S', f'"id": "{catalog_id}"', head, '--', str(CATALOG)).split()[0]
            prior_outcome = prior['outcome']
            note = f"prior: {catalog_id} first measurement ({prior_sha[:8]}, {prior_outcome}) via {', '.join(o['name'] for o in prior['oracles'])}"
        mutants.append({
            'id': f'post-t11-{catalog_id}', 'area': entry['area'], 'file': target, 'line': line, 'symbol': entry['symbol'],
            'operator': entry['operator'], 'original': entry['original'], 'mutated': entry['mutated'], 'prior_sha': prior_sha,
            'prior_outcome': prior_outcome, 'note': note, 'oracles': [f'schedule-http-{case}' for case in cases],
            'source_sha256': sha(Path(target).read_bytes()) if target.endswith('.ts') else None,
            'kind': 'ts' if target.endswith('.ts') else 'sql',
        })
        print('\t'.join([f'post-t11-{catalog_id}', ','.join(cases), f'{target}:{line}', prior_sha[:8], prior_outcome]))
    PLAN.write_text(json.dumps({'base_sha': base, 'oracles': oracles, 'mutants': mutants}, indent=1) + '\n')
    print(f'# {len(mutants)} served schedule targets; plan written to {PLAN}', file=sys.stderr)


if __name__ == '__main__':
    main()
