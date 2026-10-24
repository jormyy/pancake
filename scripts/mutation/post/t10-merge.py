#!/usr/bin/env python3
"""Final turn-11 rerun verdicts: one row per mutant.

  python3 scripts/mutation/post/t10-merge.py <evidence dir> > results.jsonl
<evidence dir> holds the mini evidence copied under mini/: t10/results.jsonl
(pass 1, every changed target) and t10-pass<N>/results.jsonl (targets rerun after
a served-path oracle was added or rewired, or with the final harness), then the
follow-up served schedule rows (post-t11-*) in t11/results.jsonl and
t11-pass<N>/results.jsonl. The last row per mutant is final; its reason quotes
every earlier verdict. Log paths point at the copied evidence.
"""
import json
import re
import sys
from pathlib import Path

FIELDS = ['id', 'lane', 'area', 'file', 'line', 'symbol', 'operator', 'original', 'mutated', 'base_sha', 'prior_sha',
          'prior_outcome', 'applied', 'outcome', 'reason', 'oracle_kind', 'oracle_cmds', 'baseline_exit', 'mutant_exit',
          'seconds', 'log', 'restore_sha256']
MINI = '/Users/michaelchen/pancake-t_4ba51e0d/lanes/claude-post/evidence/'
# Analysis of a final survivor; the row keeps its measured outcome.
SURVIVED = {
    'post-t11-post-t3-01': (
        'survivor analysis: equivalent on the served path. buildScheduleSyncPlan uses seasonStart only to derive '
        'seasonYear and to test that a regular season exists; sync-schedule neither persists nor returns it. The mutant '
        'takes the last regular-season date instead (April of the end year here, January-September for any single-season '
        'schedule), which seasonYearForGameDate maps to the same year as opening night (October-December), so the served '
        'worker publishes identical games and weeks and every persisted opening-night assertion holds. Only the unit '
        'oracle calendar-opening, which reads plan.seasonStart, kills it.'
    ),
}


def rows(path: Path, copied: Path) -> dict:
    found = {}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        assert list(row) == FIELDS, row['id']
        assert all(log.startswith(MINI) for log in row['log'])
        row['log'] = [str(copied / log[len(MINI):]) for log in row['log']]
        assert all(Path(log).is_file() for log in row['log']), row['id']
        found[row['id']] = row
    return found


def failed_assertions(log: str) -> list[str]:
    # post-t11-schedule-http.ts collects case failures and prints them in its final deepEqual diff.
    text = re.sub(r'\x1b\[[0-9;]*m', '', Path(log).read_text())
    return [match.rstrip(' +') for match in re.findall(r"^\+   '(.+?)(?:\\n)?'", text, re.M)]


def final(copied: Path, run: str) -> None:
    history = {mutant: [(1, row)] for mutant, row in rows(copied / f'{run}/results.jsonl', copied).items()}
    for number in range(2, 10):
        path = copied / f'{run}-pass{number}/results.jsonl'
        if not path.is_file():
            break
        for mutant, row in rows(path, copied).items():
            history[mutant].append((number, row))
    for passes in history.values():
        number, row = passes[-1]
        earlier = [f"pass {n} {before['outcome']} with {', '.join(oracle['name'] for oracle in before['oracle_cmds'])} "
                   f"(exits {before['mutant_exit']}; logs {', '.join(before['log'])})" for n, before in passes[:-1]]
        if earlier:
            row['reason'] = ' | '.join([f'pass {number}', *earlier, row['reason']])
        if run == 't11':
            failed = [line for log in row['log'] for line in failed_assertions(log)]
            if failed:
                row['reason'] += ' | failed assertion: ' + '; '.join(failed)
            if row['outcome'] == 'survived':
                row['reason'] += ' | ' + SURVIVED[row['id']]
        print(json.dumps(row))


def main() -> None:
    copied = Path(sys.argv[1]).resolve() / 'mini'
    final(copied, 't10')
    if (copied / 't11/results.jsonl').is_file():
        final(copied, 't11')


if __name__ == '__main__':
    main()
