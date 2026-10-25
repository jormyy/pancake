"""Build the turn-10 rerun catalog: prior verdicts retargeted at the current definitions.

Usage: python3 scripts/mutation/live/t10-build.py <prior results.jsonl> [extra ids...]
"""
import json
import re
import sys
from pathlib import Path

BASE_SHA = 'c392cad7'
RERUNS = ('L04 L05 L06 L22 L23 L24 L11 L12 L13 L14 W16 W17 live-sw-03 live-sw-04 '
          'W08 W09 W10 W11 L28 L29 L30 L31 L40 L41 live-pp-02').split()
# Row ranges of the prior results file and the commit each round measured.
ROUNDS = [(0, 34, '098df419'), (35, 84, 'ba1a6ac2'), (85, 104, 'c12a6be0'), (105, 107, '05861074'),
          (108, 118, '08e5e9b5'), (119, 126, 'd0afad0e'), (127, 133, 'eb86d4be'), (134, 140, '5ec9d391'),
          (141, 144, 'feeece97'), (145, 149, '10a55f80')]
RECIPE = ('E2E_INVOCATION_WORKER_HOST=host.lima.internal deno run --no-lock --check --allow-env --allow-read --allow-write '
          '--allow-net=127.0.0.1,localhost,0.0.0.0 --allow-run=psql supabase/tests/db/live-t10-season-chain.ts')
NEW = [
    dict(id='live-t10-01', area='weekly-scoring', file='supabase/functions/sync-scores/index.ts',
         symbol='supabase/functions/sync-scores/index.ts', operator='STMT-DEL',
         original='const statLines = await syncStatsThenScores(syncStatsForScoreCandidateDates, syncScores)',
         mutated='const statLines = await syncStatsThenScores(syncStatsForScoreCandidateDates, async () => {})'),
    dict(id='live-t10-02', area='season-boundary', file='supabase/functions/_shared/seasonBoundary.ts',
         symbol='supabase/functions/_shared/seasonBoundary.ts', operator='NEG',
         original='if (!finalDecided || !graceElapsed(finals, referenceDate)) return actions',
         mutated='if (finalDecided || !graceElapsed(finals, referenceDate)) return actions'),
    dict(id='live-t10-03', area='weekly-scoring', file='supabase/migrations/20261020000030_schedule_idle_score_recovery.sql',
         symbol='public.invoke_live_poll_if_due()', operator='STMT-DEL',
         original="PERFORM public.invoke_edge_function('sync-scores');", mutated='NULL;'),
    dict(id='live-t10-04', area='season-notifications', file='supabase/migrations/20261020000251_notification_first_scoring_day.sql',
         symbol='public.notif_scan_due_atomic(timestamp with time zone)', operator='STMT-DEL',
         original="WHERE season.is_current AND league.status = 'active'\n      AND v_today = private.notif_first_scoring_day(season.id)",
         mutated='WHERE season.is_current\n      AND v_today = private.notif_first_scoring_day(season.id)'),
    dict(id='live-t10-05', area='season-boundary', file='supabase/functions/_shared/seasonBoundary.ts',
         symbol='supabase/functions/_shared/seasonBoundary.ts', operator='ROR',
         original='? referenceDate.getTime() < Date.parse(cutoff)', mutated='? referenceDate.getTime() > Date.parse(cutoff)'),
    dict(id='live-t10-06', area='season-boundary', file='supabase/migrations/20261020000061_recover_rookie_backstop.sql',
         symbol='public.invoke_season_boundary_if_due(timestamp with time zone)', operator='CONST',
         original='IF v_now::time < make_time(9, 0, 0) THEN', mutated='IF v_now::time < make_time(0, 0, 0) THEN'),
]


def kind(command):
    if 'live-t10-season-chain' in command:
        return 'edge-http'
    return 'db-deployed' if command.startswith('psql') else 'ts-module-db'


def function_name(symbol):
    return symbol.split('(')[0]


def locate(mutant):
    """Latest file that defines the target and the 1-based line of the fragment's first line."""
    if not mutant['file'].endswith('.sql'):
        text = Path(mutant['file']).read_text()
        return mutant['file'], text[:text.find(mutant['original'])].count('\n') + 1 if mutant['original'] in text else None
    pattern = re.compile(r'FUNCTION\s+' + re.escape(function_name(mutant['symbol'])) + r'\s*\(', re.I)
    files = [path for path in sorted(Path('supabase/migrations').glob('*.sql')) if pattern.search(path.read_text())]
    latest = files[-1]
    text = latest.read_text()
    start = [match.start() for match in pattern.finditer(text)][-1]
    end = text.find('$$;', text.find('$$', start) + 2)
    body = text[start:end]
    if body.count(mutant['original']) != 1:
        return str(latest), None
    return str(latest), text[:start + body.find(mutant['original'])].count('\n') + 1


def main():
    prior_rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
    prior = {}
    for index, row in enumerate(prior_rows):
        sha = next(commit for first, last, commit in ROUNDS if first <= index <= last)
        prior[row['id']] = dict(prior_sha=sha, prior_outcome=row['outcome'])
    catalog = {m['id']: m for m in json.loads(Path('scripts/mutation/live/catalog.json').read_text())}
    selected = []
    for mutant_id in RERUNS + sys.argv[2:]:
        mutant = dict(catalog[mutant_id])
        mutant.update(prior.get(mutant_id, dict(prior_sha=None, prior_outcome=None)))
        selected.append(mutant)
    for mutant in NEW:
        selected.append(dict(mutant, oracles=[RECIPE], prior_sha=None, prior_outcome=None, timeout=480))
    # W17 survives its recorded oracle at the base SHA: 036 skips unchanged finalized rows, and that oracle only
    # re-finalizes rows it already marked final. The real cron->worker path finalizes fresh weeks.
    selected.append(dict(catalog['W17'], id='W17-r', oracles=[RECIPE], timeout=480, **prior['W17']))
    for mutant in selected:
        mutant['file'], mutant['line'] = locate(mutant)
        mutant['oracle_kind'] = kind(mutant['oracles'][0])
        mutant['base_sha'] = BASE_SHA
    Path('scripts/mutation/live/t10-catalog.json').write_text(json.dumps(selected, indent=2) + '\n')
    for mutant in selected:
        print(mutant['id'], mutant['file'], mutant['line'], mutant['prior_sha'], mutant['prior_outcome'])


if __name__ == '__main__':
    main()
