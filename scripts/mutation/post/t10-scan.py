#!/usr/bin/env python3
"""Turn-10 rerun plan for the post catalog (common-t10 protocol).

Run from the repository root on a checkout at the rerun base:
  python3 scripts/mutation/post/t10-scan.py <post results.jsonl> > scan.tsv
It compares every catalog target with the source it was measured on and writes
scripts/mutation/post/t10-plan.json for rerun-t10.mjs.
- TypeScript: the measured file is identified by the restore SHA-256 recorded
  in its result row; a target changed when the file at HEAD hashes differently.
- SQL: a target changed when a migration newer than the catalog file redefines
  the function at HEAD (the latest CREATE OR REPLACE wins when deployed).
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

CATALOG = Path('scripts/mutation/post/catalog.json')
PLAN = Path('scripts/mutation/post/t10-plan.json')
HTTP_TEST = 'supabase/tests/db/post-t10-boundary-http.ts'

# The original text now occurs twice in the current file. The rerun keeps the
# operator and the call site the prior verdict mutated, extended by one
# adjacent line so it matches exactly one application expression.
RETARGET = {
    'post-stale-05': (
        'await syncScores(leagueId, referenceDate, { recoverStats: false })\n  const refreshed',
        'await syncScores(leagueId, referenceDate, { recoverStats: true })\n  const refreshed',
        'context-disambiguated: the original also occurs in refreshUnavailableRegularSeason (added after the prior '
        'measurement); the rerun mutates the stale-certificate refresh call it targeted before',
    ),
    'post-t4-08': (
        'p_is_mock: false,\n      p_pick_timer_seconds: 60',
        'p_is_mock: false,\n      p_pick_timer_seconds: 30',
        'context-disambiguated: the original also occurs in the draft_timer_start_warning call (added after the prior '
        'measurement); the rerun mutates the start_rookie_draft_atomic caller it targeted before',
    ),
}

# Served-path oracle cases (edge-http) added for representative seasonBoundary.ts mutants.
# Turn-11 pass 2: post-sw-10 survived rookie-skipped-week alone and rookie-draft-15
# passed skipped-fallback (a fresh draft's live timer accepts any reason).
HTTP = {
    'rookie-draft-11': 'drafting-cutoff',
    'rookie-draft-12': 'drafting-cutoff',
    'rookie-draft-13': 'skipped-fallback',
    'rookie-draft-14': 'skipped-fallback',
    'rookie-draft-15': 'expired-fallback',
    'rookie-draft-18': 'drafting-cutoff',
    'rookie-draft-21': 'skipped-fallback',
    'post-sw-08': 'skipped-fallback',
    'post-sw-09': 'skipped-fallback',
    'post-sw-10': 'skipped-fallback',
    'post-t4-08': 'skipped-fallback',
    'post-stale-01': 'stale-rollover',
    'post-stale-02': 'stale-rollover',
    'post-stale-03': 'stale-rollover',
}


def git(*args: str) -> str:
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def oracle_kind(command: str) -> str:
    if HTTP_TEST in command:
        return 'edge-http'
    if '.sql' in command:
        return 'db-deployed'
    if 'calendar-seasons.ts' in command:
        # buildScheduleSyncPlan on pinned REAL-DERIVED schedules; no database or served worker.
        return 'unit'
    if re.search(r'supabase/tests/db/(rookie-backstop|rookie-skipped-week|playoff-stale-boundary|calendar-publish|calendar-ingestion|matchup-order-seasons|playoff-clinched)\.ts', command):
        # Imports the application module in a Deno process that reads and writes the running stack.
        return 'ts-module-db'
    raise SystemExit(f'Unclassified oracle command: {command}')


def function_statement(text: str, name: str) -> tuple[int, str] | None:
    schema, fn = name.split('.')
    match = None
    for found in re.finditer(r'create\s+(?:or\s+replace\s+)?function\s+"?%s"?\."?%s"?\s*\(' % (schema, fn), text, re.I):
        match = found
    if not match:
        return None
    end = text.find('$$;', text.find('$$', match.end()) + 2)
    return match.start(), text[match.start():end + 3]


def main() -> None:
    head = git('rev-parse', 'HEAD').strip()
    catalog = json.loads(CATALOG.read_text())
    results = {row['id']: row for row in map(json.loads, Path(sys.argv[1]).read_text().splitlines())}
    migrations = sorted(Path('supabase/migrations').glob('*.sql'))
    texts = {path: path.read_text() for path in migrations}
    names = {}
    for entry in catalog:
        for oracle in entry['oracles']:
            names[oracle['name']] = oracle['command']
    oracles = {name: {'kind': oracle_kind(command), 'command': command} for name, command in names.items()}
    for case in sorted(set(HTTP.values())):
        command = f'POST_HTTP_CASE={case} node scripts/mutation/post/check.mjs {HTTP_TEST}'
        oracles[f'boundary-http-{case}'] = {'kind': oracle_kind(command), 'command': command}
    mutants, print_rows = [], []
    for entry in catalog:
        prior = results[entry['id']]
        restore = re.findall(r'Restore SHA-256 verified: ([0-9a-f]{64})', prior['notes'])
        if entry['file'].endswith('.ts'):
            current_bytes = Path(entry['file']).read_bytes()
            current = sha(current_bytes)
            measured = restore[-1]
            changed = measured != current
            prior_sha = next((commit for commit in git('rev-list', head, '--', entry['file']).split()
                              if sha(subprocess.run(['git', 'show', f'{commit}:{entry["file"]}'], capture_output=True).stdout) == measured), None)
            source = current_bytes.decode()
            target_file = entry['file']
            offset = 0
            note = f'file sha256 measured {measured[:12]} current {current[:12]}'
        else:
            name = entry['symbol'].split('(')[0]
            defining = [path for path in migrations if function_statement(texts[path], name)]
            latest = defining[-1]
            changed = latest.name != Path(entry['file']).name
            prior_sha = git('log', '--reverse', '--format=%H', '-S', f'"id": "{entry["id"]}"', head, '--', str(CATALOG)).split()[0]
            offset, source = function_statement(texts[latest], name)
            target_file = str(latest)
            note = f'catalog {Path(entry["file"]).name} latest {latest.name}'
        print_rows.append('\t'.join([entry['id'], 'CHANGED' if changed else 'same', note]))
        if not changed:
            continue
        original, mutated, reason = RETARGET.get(entry['id'], (entry['original'], entry['mutated'], ''))
        if entry['id'] in RETARGET:
            assert entry['original'] in original and original.replace(entry['original'], entry['mutated']) == mutated
        count = source.count(original)
        file_text = Path(target_file).read_text()
        line = file_text[:offset + source.find(original)].count('\n') + 1 if count == 1 else None
        names_for = [oracle['name'] for oracle in entry['oracles']]
        if entry['id'] in HTTP:
            names_for.append(f'boundary-http-{HTTP[entry["id"]]}')
        mutants.append({
            'id': entry['id'], 'area': entry['area'], 'file': target_file, 'line': line, 'symbol': entry['symbol'],
            'operator': entry['operator'], 'original': original, 'mutated': mutated, 'prior_sha': prior_sha,
            'prior_outcome': prior['outcome'], 'retarget_reason': reason, 'occurrences': count, 'oracles': names_for,
            'source_sha256': sha(Path(target_file).read_bytes()) if target_file.endswith('.ts') else None,
            'kind': 'ts' if target_file.endswith('.ts') else 'sql',
        })
    PLAN.write_text(json.dumps({'base_sha': head, 'oracles': oracles, 'mutants': mutants}, indent=1) + '\n')
    print('\n'.join(print_rows))
    print(f'# {len(mutants)} changed targets of {len(catalog)}; plan written to {PLAN}', file=sys.stderr)


if __name__ == '__main__':
    main()
