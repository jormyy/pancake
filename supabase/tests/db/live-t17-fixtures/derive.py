"""Derive the live-t17 fixtures from the pinned replay store (read only).

Usage: python3 -I derive.py <store> <out>

<store> is the shared/sim2/replay folder (manifest.jsonl, games.json and gzip bodies).
<out> receives listing.json.gz (gzip of the listing JSON) and the stored final boxes, copied byte for byte.

The ESPN roster pages the recipe serves are REAL-DERIVED. For each refresh date D (06:00 ET), an
athlete is listed on the team of the latest pinned 2024-25 NBA box dated on or before D that lists
him, in any status. A box is the team's own roster report for that game, so a trade shows up in
the first box after it. His ESPN id, name and position come from the pinned ESPN game summaries,
matched to the NBA person in the same game and team by name, then by jersey. The injuries feed
lists him as Out when that latest box gives INACTIVE_INJURY or DND_INJURY. The NBA player index
for D lists every person in a box dated on or before D, with the box's names. Two omissions are
CONSTRUCTED (OMIT): no pinned input records an ESPN roster page.
"""
import gzip, hashlib, json, os, sys, unicodedata

STORE, OUT = sys.argv[1], sys.argv[2]
REFRESHES = ['2025-01-27', '2025-01-29', '2025-02-04', '2025-02-05', '2025-02-07', '2025-02-08', '2025-02-10', '2025-02-12', '2025-02-13']
STORED = ['0022400648', '0022400657', '0022400663', '0022400715', '0022400712', '0022400720', '0022400737', '0022400741', '0022400742',
          '0022400758', '0022400768', '0022400762', '0022400783', '0022401004']
# Constructed ESPN omissions: (NBA person id, first refresh omitting him, last refresh omitting him).
OMIT = [(1630559, '2025-02-05', '2025-02-13'), (1627732, '2025-02-10', '2025-02-10')]
ESPN_TO_NBA = {'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 'UTAH': 'UTA', 'WSH': 'WAS'}
INJURED = {'INACTIVE_INJURY', 'DND_INJURY'}
LAST = REFRESHES[-1]

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
    games = json.load(handle)['games']
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

refreshes = []
for day in REFRESHES:
    rosters = {abbreviation: [] for abbreviation in sorted(team_ids)}
    out, index, constructed = [], [], []
    nba_to_espn = {ESPN_TO_NBA.get(a, a): a for a in team_ids}
    for person in sorted(listings):
        seen = [row for row in listings[person] if row[0] <= day]
        if not seen:
            continue
        date, _, team, reason, played = max(seen, key=lambda row: (row[0], row[1]))
        index.append(person)
        espn = espn_of.get(person)
        if not espn:
            continue
        if any(p == person and first <= day <= last for p, first, last in OMIT):
            constructed.append({'espn': espn, 'person': person, 'omittedFrom': nba_to_espn[team]})
            continue
        rosters[nba_to_espn[team]].append(espn)
        if reason in INJURED:
            out.append(espn)
    assert all(rosters.values()) and sum(map(len, rosters.values())) >= 350, day
    refreshes.append({'date': day, 'rosters': rosters, 'out': sorted(out), 'index': index, 'constructed': constructed})

os.makedirs(OUT, exist_ok=True)
stored = []
for game_id in STORED:
    row, packed, body = raw('boxscore-' + game_id)
    name = f"boxscore-{game_id}-{row['sha256']}.json.gz"
    with open(os.path.join(OUT, name), 'wb') as handle:
        handle.write(packed)
    stored.append({'game': game_id, 'file': name, 'retrievedAt': row['retrievedAt'], 'bytes': row['bytes'], 'sha256': row['sha256'],
                   'date': next(g['date'] for g in games if g['id'] == game_id), 'tipoffUtc': next(g['time'] for g in games if g['id'] == game_id)})
listing = {
    'provenance': 'REAL-DERIVED from pinned REAL-RAW NBA boxes and ESPN summaries; constructed omissions are listed per refresh',
    'derivation': 'supabase/tests/db/live-t17-fixtures/derive.py',
    'store': {'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'gamesSha256': hashlib.sha256(open(os.path.join(STORE, 'games.json'), 'rb').read()).hexdigest(),
              'boxesAndSummariesRead': len(set(used)), 'readDigest': hashlib.sha256('\n'.join(sorted(set(used))).encode()).hexdigest(), 'lastBoxDate': max(g['date'] for g in season)},
    'matching': {**matched_by, 'linkedPeople': len(espn_of), 'people': len(people), 'conflicts': conflicts},
    'teams': [[abbreviation, team_ids[abbreviation], ESPN_TO_NBA.get(abbreviation, abbreviation)] for abbreviation in sorted(team_ids)],
    'athletes': {espn: [*espn_info[espn], person] for person, espn in sorted(espn_of.items())},
    'people': {str(person): list(names) for person, names in sorted(people.items())},
    'stored': stored,
    'refreshes': refreshes,
}
body = (json.dumps(listing, separators=(',', ':'), ensure_ascii=False, sort_keys=True) + '\n').encode()
with open(os.path.join(OUT, 'listing.json.gz'), 'wb') as handle:
    handle.write(gzip.compress(body, compresslevel=9, mtime=0))
print(json.dumps({'listingSha256': hashlib.sha256(body).hexdigest(), 'games': len(season), 'read': len(set(used)), 'matching': {k: v for k, v in listing['matching'].items() if k != 'conflicts'}, 'conflicts': len(conflicts),
                  'conflictSample': conflicts[:8], 'listed': {r['date']: sum(map(len, r['rosters'].values())) for r in refreshes},
                  'index': {r['date']: len(r['index']) for r in refreshes}, 'constructed': {r['date']: r['constructed'] for r in refreshes if r['constructed']}}, ensure_ascii=False))
