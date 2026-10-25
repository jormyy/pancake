import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
manifest = {row['key']: row for row in map(json.loads, (args.fixtures / 'manifest.jsonl').read_text().splitlines())}
games = json.loads((args.fixtures / 'games.json').read_text())['games']
rows = []
missing = []


def instant(value):
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ' if '.' in value else '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()


for game in games:
    if not game['id'].startswith('00225'):
        continue
    entry = manifest.get('playbyplay-' + game['id'])
    if not entry or entry['status'] != 200:
        missing.append(game['id'])
        continue
    raw = gzip.open(args.fixtures / entry['file'], 'rb').read()
    assert hashlib.sha256(raw).hexdigest() == entry['sha256'], game['id']
    actions = sorted(json.loads(raw)['game']['actions'], key=lambda action: action['orderNumber'])
    first = instant(actions[0]['timeActual'])
    quarter = [action for action in actions if action['period'] == 1]
    end = [action for action in actions if action['actionType'] == 'game' and action['subType'] == 'end'][-1]
    scheduled = instant(game['time'])
    q1_end = instant(quarter[-1]['timeActual'])
    last_check = scheduled + 600
    next_check = math.ceil((last_check + 1800) / 120) * 120
    first_q1_tick = math.ceil(first / 120) * 120
    rows.append(dict(id=game['id'], scheduled=game['time'], first_action=actions[0]['timeActual'],
                     delay_minutes=(first - scheduled) / 60, first=first, end=instant(end['timeActual']),
                     q1_end=q1_end, old_last_check=last_check, old_next_check=next_check,
                     q1_gap=first > last_check and first_q1_tick <= q1_end,
                     whole_q1_gap=first > last_check and first_q1_tick <= q1_end < next_check,
                     early_board_checks=max(0, math.ceil(first / 20) - math.floor(last_check / 20)),
                     pbp_sha256=entry['sha256']))
for row in rows:
    others = [other for other in rows if other['id'] != row['id'] and other['first'] <= row['q1_end'] and other['end'] >= row['first']]
    row['other_game_live_during_q1'] = [other['id'] for other in others]
    row['other_game_live_at_tip'] = [other['id'] for other in others if other['first'] <= row['first'] <= other['end']]
delays = sorted(row['delay_minutes'] for row in rows)
checks = sorted(row['early_board_checks'] for row in rows if row['delay_minutes'] > 10)


def percentile(fraction):
    index = (len(delays) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    return delays[low] + (delays[high] - delays[low]) * (index - low)


report = dict(provenance='REAL-DERIVED from pinned REAL-RAW NBA PBP and fixture games.json schedule',
              assumptions='Exposure counts assume the last Scheduled check at T+10 and the next 30-minute retry rounded to a UTC two-minute cron tick. No transport latency is assumed. Other-game overlap is potential rescue, not a measured replay. saveScoreboardGames fetches missing non-Scheduled games from the full daily board, so another live worker can rescue excluded delayed games.',
              games=len(rows), missing=missing, over_10_minutes=sum(delay > 10 for delay in delays),
              p50_minutes=percentile(.5), p95_minutes=percentile(.95), max_minutes=max(delays),
              q1_gap=sum(row['q1_gap'] for row in rows),
              whole_q1_gap=sum(row['whole_q1_gap'] for row in rows),
              whole_q1_gap_no_other_live=sum(row['whole_q1_gap'] and not row['other_game_live_during_q1'] for row in rows),
              delayed_no_other_live_at_tip=sum(row['q1_gap'] and not row['other_game_live_at_tip'] for row in rows),
              late_tip_window_minutes=45,
              extra_early_board_checks=dict(p50=checks[len(checks) // 2], p95=checks[math.ceil(len(checks) * .95) - 1], maximum=max(checks),
                  bound_checks_after_minute_10=105, bound_net_checks_vs_one_old_retry=104,
                  assumption='Healthy transport; UTC-aligned 20-second worker ticks, isolated late game, last old check at T+10. Counts include the first live discovery and stop there. Concurrent games share one daily scoreboard request.'),
              games_detail=rows)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'games_detail'}, indent=2))
print('latest tips', sorted([(row['id'], row['delay_minutes']) for row in rows], key=lambda row: row[1])[-10:])
