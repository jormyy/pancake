"""Derive the live-t19 fixtures from the pinned replay store (read only).

Usage: python3 -I derive.py <store> <out> <reuse>...

<store> is the shared/sim2/replay folder (manifest.jsonl, games.json and gzip bodies).
<out> receives listing-<scenario>.json.gz (gzip of each listing JSON) and the stored final boxes, copied byte for
byte. A box already present, byte for byte, in one of the <reuse> folders (live-t17-fixtures, live-t18-fixtures) is
not written again.

The ESPN pages are derived exactly as in live-t18-fixtures/derive.py. For each refresh date D (06:00 ET), an
athlete is listed on the team of the latest pinned 2024-25 NBA box dated on or before D that lists him, in any
status. His ESPN id, name and position come from the pinned ESPN game summaries, matched to the NBA person in the
same game and team by name, then by jersey. The injuries feed lists him as Out when that latest box gives
INACTIVE_INJURY or DND_INJURY. The NBA player index for D lists every person in a box dated on or before D, under
the box's name. Each scenario lists what it CONSTRUCTS:
- merge: Ben Simmons (the live-t18 window, Brooklyn and Clippers games 2025-02-08 to 02-23) is off every ESPN page
  from 2025-02-10 through 2025-02-23 (the rest of the window). ESPN names him "Benjamin Simmons", a name whose import key differs from the
  box's "Ben Simmons", and the player index leaves him out until 2025-02-13 and then lists him under ESPN's name.
  So his real 2025-02-12 Clippers box creates a row of its own, and the next sync-players merges the ESPN row
  into it (the NBA index step), as the identity recipes' "index without his row" case does for real names.
- second-move: the rescinded February 2025 trade. Mark Williams (CHA) is in the Lakers' box of 2025-02-08 and back in
  Charlotte's from 2025-02-09; Dalton Knecht (LAL) is in Charlotte's box of 2025-02-07 and back in the Lakers' from
  2025-02-10. Both are off every ESPN page from 2025-02-07 through 2025-03-02 (the trade, its rescission, the
  All-Star break and the two weeks after), so their real boxes are the only evidence of both moves. Charlotte and the
  Lakers play on the same dates from 2025-02-10 through 2025-02-26, so a held wrong team still has a game until
  2025-02-28 (Lakers only), 2025-03-01 (Charlotte only) and 2025-03-02 (Lakers only). Refreshes run daily from
  2025-02-04 through 2025-03-02, and the stored boxes are every pinned Charlotte and Lakers game of those days.
"""
import gzip, hashlib, json, os, sys, unicodedata
from datetime import date, timedelta

STORE, OUT, REUSE = sys.argv[1], sys.argv[2], sys.argv[3:]
ESPN_TO_NBA = {'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 'UTAH': 'UTA', 'WSH': 'WAS'}
INJURED = {'INACTIVE_INJURY', 'DND_INJURY'}
SCENARIOS = {
    'merge': {
        'first': '2025-02-08', 'last': '2025-02-23', 'teams': {'BKN', 'LAC'},
        # (NBA person id, first refresh omitting him, last refresh omitting him)
        'omit': [(1627732, '2025-02-10', '2025-02-23')],
        # ESPN's constructed name for a person, used by his roster page, the injuries feed and the player index.
        'espnName': {1627732: 'Benjamin Simmons'},
        # The player index omits a person before this refresh, then lists him under ESPN's name.
        'indexFrom': {1627732: '2025-02-13'},
        'track': {'simmons': 1627732, 'harden': 201935, 'zubac': 1627826, 'claxton': 1629651},
    },
    'second-move': {
        'first': '2025-02-04', 'last': '2025-03-02', 'teams': {'CHA', 'LAL'},
        'omit': [(1631109, '2025-02-07', '2025-03-02'), (1642261, '2025-02-07', '2025-03-02')],
        'espnName': {}, 'indexFrom': {},
        'track': {'williams': 1631109, 'knecht': 1642261, 'ball': 1630163, 'reaves': 1630559},
    },
}
LAST = max(s['last'] for s in SCENARIOS.values())

manifest = {}
with open(os.path.join(STORE, 'manifest.jsonl'), 'rb') as handle:
    manifest_bytes = handle.read()
for line in manifest_bytes.decode().splitlines():
    row = json.loads(line)
    manifest[row['key']] = row
used = []

def raw(key):
    row = manifest[key]
    assert row['provenance'] == 'REAL-RAW' and row['status'] == 200, key
    with open(os.path.join(STORE, row['file']), 'rb') as handle:
        packed = handle.read()
    body = gzip.decompress(packed)
    assert hashlib.sha256(body).hexdigest() == row['sha256'] and len(body) == row['bytes'], key
    used.append(f"{key} {row['sha256']}")
    return row, packed, body

def norm(name):
    text = ''.join(c for c in unicodedata.normalize('NFKD', name) if not unicodedata.combining(c)).lower()
    words = ''.join(c if c.isalnum() or c == ' ' else ' ' if c == '-' else '' for c in text).split()
    return ' '.join(w for w in words if w not in ('jr', 'sr', 'ii', 'iii', 'iv', 'v'))

with open(os.path.join(STORE, 'games.json'), 'rb') as handle:
    games_bytes = handle.read()
games = json.loads(games_bytes)['games']
season = sorted((g for g in games if g['id'].startswith('00224') and g['date'] <= LAST), key=lambda g: (g['time'], g['id']))
listings = {}   # person -> [(date, time, team, reason, played)]
people = {}     # person -> (firstName, familyName)
espn_of, conflicts, matched_by, pairs = {}, [], {'name': 0, 'jersey': 0}, []
espn_info = {}  # espn id -> (displayName, position)
team_ids = {}   # ESPN abbreviation -> ESPN team id
box_teams = {}  # game -> (home, away)
for game in season:
    _, _, body = raw('boxscore-' + game['id'])
    box = json.loads(body)['game']
    assert box['gameStatus'] == 3 and box['homeTeam']['teamTricode'] == game['home'] and box['awayTeam']['teamTricode'] == game['away'], game['id']
    box_teams[game['id']] = (game['home'], game['away'])
    sides = {}
    for side in ('homeTeam', 'awayTeam'):
        team = box[side]['teamTricode']
        sides[team] = box[side]['players']
        for player in box[side]['players']:
            person = player['personId']
            people[person] = (player['firstName'], player['familyName'])
            listings.setdefault(person, []).append((game['date'], game['time'], team, player.get('notPlayingReason') or '', player.get('played') == '1'))
    _, _, body = raw('summary-' + game['espnId'])
    for group in json.loads(body)['boxscore']['players']:
        abbreviation = group['team']['abbreviation']
        team_ids.setdefault(abbreviation, group['team']['id'])
        assert team_ids[abbreviation] == group['team']['id'], abbreviation
        team = ESPN_TO_NBA.get(abbreviation, abbreviation)
        assert team in sides, (game['id'], abbreviation)
        for entry in group['statistics'][0]['athletes']:
            athlete = entry['athlete']
            espn_info[athlete['id']] = (athlete['displayName'], athlete.get('position', {}).get('abbreviation') or '')
            named = [p for p in sides[team] if norm(f"{p['firstName']} {p['familyName']}") == norm(athlete['displayName'])]
            if len(named) == 1:
                pairs.append(('name', named[0]['personId'], athlete['id'], game['id']))
                continue
            numbered = [p for p in sides[team] if p.get('jerseyNum') and p['jerseyNum'] == athlete.get('jersey')]
            if len(numbered) == 1:
                pairs.append(('jersey', numbered[0]['personId'], athlete['id'], game['id']))
            else:
                conflicts.append(['unmatched', game['id'], athlete['id'], athlete['displayName']])
# Name links first; a jersey link only joins a person and an ESPN id that no name link claimed.
for how in ('name', 'jersey'):
    found = {}
    for kind, person, espn, game_id in pairs:
        if kind == how and person not in espn_of and espn not in espn_of.values():
            found.setdefault(person, set()).add(espn)
    owners = {}
    for person, ids in found.items():
        for espn in ids:
            owners.setdefault(espn, set()).add(person)
    for person, ids in sorted(found.items()):
        if len(ids) == 1 and len(owners[next(iter(ids))]) == 1:
            espn_of[person] = next(iter(ids))
            matched_by[how] += 1
        else:
            conflicts.append([how + '-ambiguous', person, sorted(ids)])
assert sorted(ESPN_TO_NBA.get(a, a) for a in team_ids) == sorted({t for pair in box_teams.values() for t in pair}) and len(team_ids) == 30
claimed = {}
for person, espn in espn_of.items():
    assert claimed.setdefault(espn, person) == person, ('espn id on two people', espn)

os.makedirs(OUT, exist_ok=True)
reports = {}
for scenario, spec in SCENARIOS.items():
    first, last, teams, omit = spec['first'], spec['last'], spec['teams'], spec['omit']
    for name, person in spec['track'].items():
        assert person in espn_of, ('tracked person has no ESPN id', scenario, name)
        assert any(team in teams for _, _, team, _, _ in listings[person]), ('tracked person never on a scenario team', scenario, name)
    refreshes = []
    days = [(date.fromisoformat(first) + timedelta(days=offset)).isoformat() for offset in range((date.fromisoformat(last) - date.fromisoformat(first)).days + 1)]
    for day in days:
        rosters = {abbreviation: [] for abbreviation in sorted(team_ids)}
        out, index, constructed = [], [], []
        nba_to_espn = {ESPN_TO_NBA.get(a, a): a for a in team_ids}
        for person in sorted(listings):
            seen = [row for row in listings[person] if row[0] <= day]
            if not seen:
                continue
            _, _, team, reason, _ = max(seen, key=lambda row: (row[0], row[1]))
            if day >= spec['indexFrom'].get(person, ''):
                index.append(person)
            else:
                constructed.append({'indexOmits': person})
            espn = espn_of.get(person)
            if not espn:
                continue
            if any(p == person and start <= day <= end for p, start, end in omit):
                constructed.append({'espn': espn, 'person': person, 'omittedFrom': nba_to_espn[team]})
                continue
            rosters[nba_to_espn[team]].append(espn)
            if reason in INJURED:
                out.append(espn)
        assert all(rosters.values()) and sum(map(len, rosters.values())) >= 350, (scenario, day)
        refreshes.append({'date': day, 'rosters': rosters, 'out': sorted(out), 'index': index, 'constructed': constructed})
    stored = []
    for game in season:
        if not (first <= game['date'] <= last) or not ({game['home'], game['away']} & teams):
            continue
        row, packed, body = raw('boxscore-' + game['id'])
        name = f"boxscore-{game['id']}-{row['sha256']}.json.gz"
        previous = [os.path.join(folder, name) for folder in REUSE if os.path.exists(os.path.join(folder, name))]
        for path in previous:
            with open(path, 'rb') as handle:
                assert handle.read() == packed, ('reused box differs', path)
        if not previous:
            with open(os.path.join(OUT, name), 'wb') as handle:
                handle.write(packed)
        stored.append({'game': game['id'], 'file': name, 'retrievedAt': row['retrievedAt'], 'bytes': row['bytes'], 'sha256': row['sha256'],
                       'date': game['date'], 'tipoffUtc': game['time'], 'home': game['home'], 'away': game['away'],
                       'in': os.path.basename(os.path.normpath(os.path.dirname(previous[0]))) if previous else 'live-t19-fixtures'})
    athletes = {espn: [*espn_info[espn], person] for person, espn in sorted(espn_of.items())}
    index_names = {}
    for person, full in spec['espnName'].items():
        athletes[espn_of[person]][0] = full
        space = full.index(' ')
        index_names[str(person)] = [full[:space], full[space + 1:]]
    listing = {
        'provenance': 'REAL-DERIVED from pinned REAL-RAW NBA boxes and ESPN summaries; constructed omissions, names and index rows are listed',
        'derivation': 'supabase/tests/db/live-t19-fixtures/derive.py', 'scenario': scenario,
        'store': {'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'gamesSha256': hashlib.sha256(games_bytes).hexdigest(),
                  'boxesAndSummariesRead': len(set(used)), 'readDigest': hashlib.sha256('\n'.join(sorted(set(used))).encode()).hexdigest(), 'lastBoxDate': max(g['date'] for g in season)},
        'matching': {**matched_by, 'linkedPeople': len(espn_of), 'people': len(people), 'conflicts': conflicts},
        'constructed': {'omit': omit, 'espnName': {str(k): v for k, v in spec['espnName'].items()}, 'indexFrom': {str(k): v for k, v in spec['indexFrom'].items()}},
        'track': spec['track'],
        'teams': [[abbreviation, team_ids[abbreviation], ESPN_TO_NBA.get(abbreviation, abbreviation)] for abbreviation in sorted(team_ids)],
        'athletes': athletes,
        'people': {str(person): list(names) for person, names in sorted(people.items())},
        'indexNames': index_names,
        'stored': stored,
        'refreshes': refreshes,
    }
    body = (json.dumps(listing, separators=(',', ':'), ensure_ascii=False, sort_keys=True) + '\n').encode()
    with open(os.path.join(OUT, f'listing-{scenario}.json.gz'), 'wb') as handle:
        handle.write(gzip.compress(body, compresslevel=9, mtime=0))

    def team_on(refresh, person):
        espn = espn_of[person]
        team = next((t for t, listed in refresh['rosters'].items() if espn in listed), None)
        return (ESPN_TO_NBA.get(team, team) + (' Out' if espn in refresh['out'] else '')) if team else '-'
    lines = {}
    for name, person in spec['track'].items():
        lines[name] = [[d, t[:16], team, reason or ('played' if played else 'dnp')] for d, t, team, reason, played in sorted(listings[person]) if first <= d <= last]
    reports[scenario] = {'listingSha256': hashlib.sha256(body).hexdigest(), 'listed': {r['date']: sum(map(len, r['rosters'].values())) for r in refreshes},
                         'constructed': {r['date']: r['constructed'] for r in refreshes if r['constructed']},
                         'tracked': {name: {'espn': espn_of[person], 'espnName': athletes[espn_of[person]][0], 'teams': {r['date']: team_on(r, person) for r in refreshes}} for name, person in spec['track'].items()},
                         'lines': lines, 'stored': [[s['game'], s['date'], s['away'] + ' at ' + s['home'], s['tipoffUtc'], s['in']] for s in stored]}
print(json.dumps({'games': len(season), 'read': len(set(used)), 'matching': {k: v for k, v in matched_by.items()}, 'linked': len(espn_of), 'conflicts': len(conflicts),
                  'scenarios': reports}, ensure_ascii=False))
