import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--schedule', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.schedule.read_bytes()
schedule = json.loads(source)
examples = {('MIA', 'CHI', '2026-01-08'), ('MIA', 'CHI', '2026-01-29'),
            ('GSW', 'MIN', '2026-01-24'), ('GSW', 'MIN', '2026-01-25')}
rows = [game for game in schedule['games'] if (game['away'], game['home'], game['date']) in examples]
assert len(rows) == 4
assert sum(game['status'] == 'STATUS_POSTPONED' for game in rows) == 2
report = dict(provenance='REAL-DERIVED', source=str(args.schedule), sha256=hashlib.sha256(source).hexdigest(),
              fixture_provenance='SYNTHETIC', games=rows,
              scope='Pinned ESPN schedule observations establish dates and notes. Local scoring cases reconstruct these dates with synthetic players and points.')
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
