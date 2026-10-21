#!/usr/bin/env python3
"""Final turn-11 rerun verdicts: one row per mutant.

  python3 scripts/mutation/post/t10-merge.py <evidence dir> > results.jsonl
<evidence dir> holds the mini evidence copied under mini/: t10/results.jsonl
(pass 1, every changed target) and t10-pass<N>/results.jsonl (targets rerun after
a served-path oracle was added or rewired, or with the final harness). The last
row per mutant is final; its reason quotes every earlier verdict. Log paths
point at the copied evidence.
"""
import json
import sys
from pathlib import Path

FIELDS = ['id', 'lane', 'area', 'file', 'line', 'symbol', 'operator', 'original', 'mutated', 'base_sha', 'prior_sha',
          'prior_outcome', 'applied', 'outcome', 'reason', 'oracle_kind', 'oracle_cmds', 'baseline_exit', 'mutant_exit',
          'seconds', 'log', 'restore_sha256']
MINI = '/Users/michaelchen/pancake-t_4ba51e0d/lanes/claude-post/evidence/'


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


def main() -> None:
    evidence = Path(sys.argv[1]).resolve()
    copied = evidence / 'mini'
    history = {mutant: [(1, row)] for mutant, row in rows(copied / 't10/results.jsonl', copied).items()}
    for number in range(2, 10):
        path = copied / f't10-pass{number}/results.jsonl'
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
        print(json.dumps(row))


if __name__ == '__main__':
    main()
