#!/usr/bin/env python3
# live-t20-admin-merge: predicted starts and week totals from the committed fixtures (two UTIL slots, two players per
# member, so a healthy player whose held team plays that day is started). Usage: python3 -I predict.py <repo>
import gzip, hashlib, json, sys
from pathlib import Path
db = Path(sys.argv[1]) / 'supabase/tests/db'
d = json.loads(gzip.decompress((db / 'live-t19-fixtures/listing-merge.json.gz').read_bytes()))
folders = [db / f for f in ('live-t19-fixtures', 'live-t18-fixtures', 'live-t17-fixtures')]
S = dict(points=1, rebounds=1, assists=2, steals=3, blocks=3, turnovers=-1)
persons = dict(simmons=1627732, harden=201935, zubac=1627826, claxton=1629651)
espn = {n: next(k for k, v in d['athletes'].items() if v[2] == p) for n, p in persons.items()}
owner = dict(simmons='A', harden='A', zubac='B', claxton='B')
weeks = [(1, '2025-02-03', '2025-02-09'), (2, '2025-02-10', '2025-02-13'), (3, '2025-02-14', '2025-02-19'), (4, '2025-02-20', '2025-02-23')]
week = lambda day: next(w for w, a, b in weeks if a <= day <= b)
boxes = {}
for s in d['stored']:
    path = next(f / s['file'] for f in folders if (f / s['file']).exists())
    body = gzip.decompress(path.read_bytes()); assert hashlib.sha256(body).hexdigest() == s['sha256']
    boxes[s['game']] = (s, json.loads(body)['game'])
def line(day, name):
    for s, g in boxes.values():
        if s['date'] != day: continue
        for side in (g['homeTeam'], g['awayTeam']):
            for p in side['players']:
                if p['personId'] == persons[name]:
                    st = p['statistics']
                    pts = 0 if p['played'] != '1' else st['points'] * 1 + st['reboundsTotal'] + st['assists'] * 2 + st['steals'] * 3 + st['blocks'] * 3 - st['turnovers']
                    return dict(game=s['game'], team=side['teamTricode'], played=p['played'] == '1', fantasy=pts, points=st['points'])
    return None
refresh = {r['date']: r for r in d['refreshes']}
def team(day, name):
    r = refresh[day]
    if name == 'simmons':  # the derivation's real page under its constructed omission (undone in the recipe)
        undone = [c['omittedFrom'] for c in r['constructed'] if c.get('espn') == espn[name]]
        if undone: return undone[0]
    return next(t for t, listed in r['rosters'].items() if espn[name] in listed)
def out(day, name): return espn[name] in refresh[day]['out']
code = {a: c for a, _, c in d['teams']}
days = sorted({s['date'] for s, _ in boxes.values()})
rows = []
for day in days:
    playing = {t for s, _ in boxes.values() if s['date'] == day for t in (s['home'], s['away'])}
    for name in persons:
        t = code.get(team(day, name), team(day, name))
        started = t in playing and not out(day, name)
        l = line(day, name)
        rows.append(dict(day=day, week=week(day), name=name, member=owner[name], team=t, started=started, line=l))
tot = {}
for split in (True, False):
    for w, *_ in weeks:
        for m in 'AB':
            tot[(split, w, m)] = sum((r['line'] or {}).get('fantasy', 0) for r in rows if r['week'] == w and r['member'] == m and r['started']
                                     and not (split and r['name'] == 'simmons' and r['day'] < '2025-02-20'))
print(json.dumps(dict(starts=[[r['day'], r['name'], r['team'], r['started'], r['line']] for r in rows if r['started'] or r['line']],
    beforeMerge={w: [tot[(True, w, 'A')], tot[(True, w, 'B')]] for w, *_ in weeks if w <= 3},
    afterMerge={w: [tot[(False, w, 'A')], tot[(False, w, 'B')]] for w, *_ in weeks},
    simmonsLines=[(day, line(day, 'simmons')) for day in days if line(day, 'simmons')]), indent=1))
