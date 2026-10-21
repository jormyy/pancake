import concurrent.futures
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import urllib.request
from zoneinfo import ZoneInfo

root = Path.home() / 'pancake-t_4ba51e0d/lanes/post'
assert Path.cwd() == root / 'repo'
out = root / 'evidence/review7'
raw = out / 'raw'
raw.mkdir(parents=True, exist_ok=True)
shared = Path.home() / 'pancake-t_4ba51e0d/shared/sim/fixtures'
manifest = [json.loads(line) for line in (shared / 'manifest.jsonl').read_text().splitlines()]
pinned = {row['key']: row for row in manifest if row.get('kind') == 'espn-scoreboard' and row.get('status') == 200}

def load(day):
    key = 'scoreboard-' + day.isoformat()
    if key in pinned:
        source = pinned[key]
        data = gzip.decompress((shared / source['file']).read_bytes())
        assert hashlib.sha256(data).hexdigest() == source['sha256']
        (raw / (key + '.json.gz')).write_bytes(gzip.compress(data, mtime=0))
        (raw / (key + '.source.json')).write_text(json.dumps(source, indent=2))
    else:
        url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + day.strftime('%Y%m%d') + '&limit=1000'
        file = raw / (key + '.json.gz')
        meta = raw / (key + '.source.json')
        if file.exists() and meta.exists():
            data = gzip.decompress(file.read_bytes())
            source = json.loads(meta.read_text())
        else:
            data = urllib.request.urlopen(url, timeout=20).read()
            source = dict(url=url, retrievedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), sha256=hashlib.sha256(data).hexdigest(), provenance='REAL-RAW')
            file.write_bytes(gzip.compress(data, mtime=0))
            meta.write_text(json.dumps(source, indent=2))
    obj = json.loads(data)
    rows = []
    for game in obj.get('events', []):
        comp = game['competitions'][0]
        if game.get('season', {}).get('type') != 2:
            continue
        notes = comp.get('notes', [])
        cup_final = any('cup' in n.get('headline', '').lower() and 'championship' in n.get('headline', '').lower() for n in notes)
        date = datetime.datetime.fromisoformat(comp['date'].replace('Z', '+00:00')).astimezone(ZoneInfo('America/New_York')).date().isoformat()
        teams = {side['homeAway']: side['team']['abbreviation'] for side in comp['competitors']}
        aliases = {'GS': 'GSW', 'NY': 'NYK', 'NO': 'NOP', 'SA': 'SAS', 'UTAH': 'UTA', 'WSH': 'WAS', 'PHO': 'PHX'}
        teams = {key: aliases.get(value, value) for key, value in teams.items()}
        nba_teams = set('ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS'.split())
        if not all(team in nba_teams for team in teams.values()):
            continue
        status = game.get('status', comp.get('status', {})).get('type', {})
        rows.append(dict(gameId=('006-espn-' if cup_final else 'espn-') + game['id'], espnId=game['id'], gameDate=date,
            homeTeam=teams['home'], awayTeam=teams['away'], status='Final' if status.get('completed') else 'Scheduled',
            statusText=status.get('description'), startedAt=comp['date'], weekNumber=None, notes=notes, sourceDate=day.isoformat(), cupFinal=cup_final))
    return dict(date=day.isoformat(), **{k: source[k] for k in ['url', 'retrievedAt', 'sha256']}, provenance='REAL-RAW'), rows

for year, end in [(2024, '2025-04-13'), (2025, '2026-04-12')]:
    first = datetime.date(year, 10, 20)
    last = datetime.date.fromisoformat(end)
    days = [first + datetime.timedelta(days=i) for i in range((last-first).days+1)]
    loaded = list(concurrent.futures.ThreadPoolExecutor(max_workers=5).map(load, days))
    sources, all_games = zip(*loaded)
    games = {}
    postponements = []
    for rows in all_games:
        for game in rows:
            if 'postpon' in (game['statusText'] or '').lower():
                postponements.append(game)
            if game['cupFinal']:
                nba_id = '006' + str(year % 100) + '00001'
                page = raw / f'cup-game-{year}.html'
                assert nba_id.encode() in page.read_bytes()
                game['gameId'] = nba_id
                game['nbaIdSource'] = json.loads((raw / f'cup-game-{year}.source.json').read_text())
            games[game['gameId']] = game
    first_game = min(g['gameDate'] for g in games.values())
    opening = datetime.date.fromisoformat(first_game)
    monday = opening - datetime.timedelta(days=opening.weekday())
    for game in games.values():
        game['weekNumber'] = (datetime.date.fromisoformat(game['gameDate']) - monday).days // 7 + 1
    value = dict(provenance='REAL-DERIVED', transformation='ESPN regular-season events with thirty NBA team codes; aliases normalized; ET dates; stable ESPN event IDs; Cup final NBA IDs join the pinned official NBA game page; other game IDs retain stable ESPN event IDs; provider week numbers derive from opening-week Monday; original postponed snapshots retained separately', sources=sources, games=sorted(games.values(), key=lambda row: (row['gameDate'], row['gameId'])), postponements=postponements)
    target = root / 'repo/tests/fixtures/calendar' / f'espn-{year}-{year+1}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, separators=(',', ':'))+'\n')
    print(json.dumps(dict(file=str(target), sha256=hashlib.sha256(target.read_bytes()).hexdigest(), games=len(games), cupFinals=[g for g in games.values() if g['cupFinal']], postponements=postponements)), flush=True)
