import concurrent.futures
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.error
import urllib.request

root = Path.cwd()
raw = root / 'raw'
evidence = root / 'evidence'
fixture = root / 'tests/fixtures/identity'
fixture.mkdir(parents=True, exist_ok=True)
raw.mkdir(exist_ok=True)
evidence.mkdir(exist_ok=True)
headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
           'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
           'Accept': 'application/json, text/plain, */*'}


def fetch(game_id):
    name = 'boxscore-' + game_id + '.json'
    if (raw / name).exists():
        return
    url = 'https://cdn.nba.com/static/json/liveData/boxscore/boxscore_' + game_id + '.json?season=2024-25'
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as response:
            body = response.read()
            status = response.status
        (raw / name).write_bytes(body)
        row = dict(provenance='REAL-RAW', url=url, retrieved_at=at, status=status,
                   bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), path='raw/' + name)
    except urllib.error.HTTPError as error:
        row = dict(url=url, retrieved_at=at, status=error.code, error=str(error))
    with (evidence / 'provenance.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    print(json.dumps(row), flush=True)


def pin_source(name, urls):
    if raw.joinpath(name).exists():
        return
    for url in urls:
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as response:
                body = response.read()
                status = response.status
            raw.joinpath(name).write_bytes(body)
            row = dict(provenance='REAL-RAW', url=url, retrieved_at=at, status=status,
                       bytes=len(body), sha256=hashlib.sha256(body).hexdigest(), path='raw/' + name)
        except urllib.error.HTTPError as error:
            row = dict(url=url, retrieved_at=at, status=error.code, error=str(error))
        with evidence.joinpath('provenance.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        if raw.joinpath(name).exists():
            return
    raise RuntimeError('No real source available for ' + name)


def normalized(name):
    name = ''.join(c for c in unicodedata.normalize('NFD', name) if not unicodedata.combining(c)).lower()
    name = re.sub(r'\s+(jr\.?|sr\.?|ii|iii|iv|v)$', '', name)
    return re.sub(r"[.'’\-]", '', name).strip()


pin_source('draft-news.html', ['https://www.nba.com/news/2025-nba-draft-order'])
pin_source('player-index-query.json', ['https://cdn.nba.com/static/json/staticData/playerIndex.json',
                                       'https://cdn.nba.com/static/json/staticData/playerIndex.json?season=2025-26'])
ids = [f'002240{i:04d}' for i in list(range(1, 16)) + list(range(695, 701)) + list(range(757, 767)) + [768, 781, 808, 835]]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(fetch, ids))
shared = Path.home() / 'pancake-t_4ba51e0d/shared/sim/fixtures'
html = raw.joinpath('draft-news.html').read_text()
next_data = json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)[1])
text = next_data['props']['pageProps']['article']['contentText']
picks = [dict(pick=int(match[1]), name=match[2].strip()) for line in text.splitlines()
         if (match := re.match(r'^([0-9]+)\.\s+.+?\s+draft\s+(.+?)\s+\(', line))]
people = {}
game_rows = []
for path in sorted(shared.glob('boxscore-00225*.json.gz')):
    game = json.loads(gzip.decompress(path.read_bytes()))['game']
    game_rows.append(dict(gameId=game['gameId'], date=game['gameEt'][:10], home=game['homeTeam']['teamTricode'],
                          away=game['awayTeam']['teamTricode'], time=game['gameTimeUTC']))
    for team in [game['homeTeam'], game['awayTeam']]:
        for player in team['players']:
            pid = str(player['personId'])
            person = people.setdefault(pid, dict(personId=pid, names=[], games=[]))
            identity = {key: player[key] for key in ['name', 'firstName', 'familyName']}
            if identity not in person['names']:
                person['names'].append(identity)
            person['games'].append(dict(gameId=game['gameId'], date=game['gameEt'][:10], team=team['teamTricode'],
                                        played=player.get('played'), statistics=player.get('statistics'), file=path.name))
for person in people.values():
    person['games'].sort(key=lambda game: (game['date'], game['gameId']))
for pick in picks:
    matches = [person for person in people.values()
               if any(normalized(identity['name']) == normalized(pick['name']) for identity in person['names'])]
    assert len(matches) <= 1, pick
    if matches:
        pick['personId'] = matches[0]['personId']
(evidence / 'season-identities.json').write_text(json.dumps(dict(picks=picks, people=people), ensure_ascii=False))
raw_provenance = []
shared = Path.home() / 'pancake-t_4ba51e0d/shared/sim/fixtures'
for path in sorted(shared.glob('boxscore-00225*.json.gz')):
    body = gzip.decompress(path.read_bytes())
    digest = hashlib.sha256(body).hexdigest()
    assert digest in path.name
    raw_provenance.append(dict(provenance='REAL-RAW', url='https://cdn.nba.com/static/json/liveData/boxscore/boxscore_' +
                               path.name.split('-')[1] + '.json', borrowed_from=str(path),
                               retrieved_at=None, bytes=len(body), sha256=digest))
(evidence / 'borrowed-provenance.json').write_text(json.dumps(raw_provenance, indent=2))
for pick in picks:
    pid = pick.get('personId')
    if not pid:
        continue
    person = people[pid]
    pick['identities'] = person['names']
    pick['games'] = [dict(gameId=game['gameId'], date=game['date'], team=game['team'], played=game['played'],
                          stats={key: game['statistics'][key] for key in ['points', 'reboundsTotal', 'assists', 'steals',
                                                                         'blocks', 'turnovers', 'threePointersMade']})
                     for game in person['games']]
veterans = {}
old_games = []
for path in sorted(raw.glob('boxscore-00224*.json')):
    game = json.loads(path.read_bytes())['game']
    old_games.append(game)
    for team in [game['homeTeam'], game['awayTeam']]:
        for person in team['players']:
            veterans[str(person['personId'])] = dict(personId=str(person['personId']), name=person['name'],
                                                    firstName=person['firstName'], familyName=person['familyName'],
                                                    team=team['teamTricode'], source=path.name)
changes = []
for person in people.values():
    for before, after in zip(person['games'], person['games'][1:]):
        if before['team'] != after['team'] and '2026-01-20' <= after['date'] <= '2026-02-20':
            changes.append(dict(personId=person['personId'], identities=person['names'], before=before, after=after))
fixture.joinpath('games-2025.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', games=game_rows), separators=(',', ':')))
fixture.joinpath('draft-2025.html').write_bytes(raw.joinpath('draft-news.html').read_bytes())
fixture.joinpath('rookies-2025.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', picks=picks), ensure_ascii=False, separators=(',', ':')))
fixture.joinpath('veterans-2024.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', players=list(veterans.values())), ensure_ascii=False, separators=(',', ':')))
fixture.joinpath('trades-2026.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', trades=changes), ensure_ascii=False, separators=(',', ':')))
fixture.joinpath('player-index.json').write_bytes(raw.joinpath('player-index-query.json').read_bytes())
(evidence / 'non-class-players.tsv').write_text('personId\tname\tgames_played\n' + ''.join(
    person['personId'] + '\t' + person['names'][0]['name'] + '\t' + str(sum(g['played'] == '1' for g in person['games'])) + '\n'
    for person in people.values() if person['personId'] not in {pick.get('personId') for pick in picks}))
print(json.dumps(dict(veterans=len(veterans), picks=len(picks), trade_changes=len(changes),
                      fixture_bytes=sum(path.stat().st_size for path in fixture.iterdir()),
                      old_games=[dict(id=g['gameId'], date=g['gameEt'], home=g['homeTeam']['teamTricode'], away=g['awayTeam']['teamTricode']) for g in old_games])))

selected = []
for pid in ['1629029']:
    for game_id in ['0022400007', '0022400768', '0022400781', '0022400808', '0022400835']:
        game = next(game for game in old_games if game['gameId'] == game_id)
        for team in [game['homeTeam'], game['awayTeam']]:
            for player in team['players']:
                if str(player['personId']) == pid:
                    selected.append(dict(personId=pid, identity={key: player[key] for key in ['name', 'firstName', 'familyName']},
                                         gameId=game_id, date=game['gameEt'][:10], team=team['teamTricode'], played=player['played'], statistics=player['statistics']))
fixture.joinpath('trades-2025.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', games=selected), ensure_ascii=False))

fixture.joinpath('games-2024.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', games=[dict(gameId=game['gameId'], date=game['gameEt'][:10], home=game['homeTeam']['teamTricode'], away=game['awayTeam']['teamTricode'], time=game['gameTimeUTC']) for game in old_games]), separators=(',', ':')))
harden = people['201935']
old = [game for game in harden['games'] if game['team'] == 'LAC' and game['played'] == '1'][-1]
new = [game for game in harden['games'] if game['team'] == 'CLE' and game['played'] == '1'][:4]
fixture.joinpath('trade-harden.json').write_text(json.dumps(dict(provenance='REAL-DERIVED', identity=harden['names'][0], personId='201935', games=[old] + new), ensure_ascii=False, separators=(',', ':')))
assert sum(path.stat().st_size for path in fixture.iterdir()) < 2_000_000

index_rows = json.loads(fixture.joinpath('player-index.json').read_text())['resultSets'][0]
undrafted = ['personId\tname\tindex_from_year\tindex_draft_year\tindex_draft_number\tgames_found\tgames_played']
for values in index_rows['rowSet']:
    player = dict(zip(index_rows['headers'], values))
    if str(player['FROM_YEAR']) == '2025' and player['DRAFT_YEAR'] is None and player['DRAFT_NUMBER'] is None:
        pid = str(player['PERSON_ID'])
        person = people.get(pid, dict(games=[]))
        undrafted.append('\t'.join(map(str, [pid, player['PLAYER_FIRST_NAME'] + ' ' + player['PLAYER_LAST_NAME'],
                                           player['FROM_YEAR'], 'null', 'null', len(person['games']),
                                           sum(game['played'] == '1' for game in person['games'])])))
evidence.joinpath('undrafted.tsv').write_text('\n'.join(undrafted) + '\n')
