import json
from pathlib import Path
import re

rows = []
LIVE = 'live-streams'
WEEKLY = 'weekly-scoring'


def recipe(name):
    return f'psql "$SUPABASE_DB_URL" -X --set ON_ERROR_STOP=1 -f tests/db/{name}.sql'


def unit(*names):
    return 'deno test --no-lock --node-modules-dir=none --allow-env --allow-read --allow-net=127.0.0.1,localhost ' + ' '.join('supabase/functions/_shared/' + n + '.test.ts' for n in names)


def db(name):
    return f'deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/{name}.ts'


def add(area, file, line, symbol, original, mutated, oracles, operator='condition'):
    rows.append(dict(id=('L' if area == LIVE else 'W') + str(1 + sum(r['area'] == area for r in rows)).zfill(2), area=area, file=file, line=line, symbol=symbol, operator=operator, original=original, mutated=mutated, oracles=oracles))


def sql(area, name, signature, changes, oracles):
    matches = []
    for path in sorted(Path('supabase/migrations').glob('*.sql')):
        source = path.read_text()
        for match in re.finditer(r'CREATE OR REPLACE FUNCTION\s+' + re.escape(name) + r'\s*\(', source, re.I):
            end = source.index('$$;', source.index('$$', match.start()) + 2) + 3
            matches.append((path, source, match.start(), end))
    path, source, start, end = matches[-1]
    for original, mutated in changes:
        if source[start:end].count(original) != 1:
            raise ValueError((name, original, path))
        add(area, str(path), source.count('\n', 0, source.index(original, start)) + 1, name + signature, original, mutated, oracles)


def ts(area, file, changes, oracles):
    source = Path(file).read_text()
    for original, mutated in changes:
        if source.count(original) != 1:
            raise ValueError((file, original))
        add(area, file, source.count('\n', 0, source.index(original)) + 1, file, original, mutated, oracles)


sql(LIVE, 'public.save_live_game_stats_atomic', '(uuid,text,jsonb,numeric)', [
    ('v_game.live_stats_elapsed_seconds>p_elapsed_seconds', 'v_game.live_stats_elapsed_seconds<p_elapsed_seconds'),
    ("v_game.status='Final' OR ", ''),
    ('v_game.live_stats_elapsed_seconds>p_elapsed_seconds', 'v_game.live_stats_elapsed_seconds>=p_elapsed_seconds'),
], [recipe('live-snapshot-order')])
sql(LIVE, 'public.save_live_scoreboard_atomic', '(uuid,text,text,integer,integer,text,numeric)', [
    ('v_game.live_scoreboard_elapsed_seconds>p_elapsed_seconds', 'v_game.live_scoreboard_elapsed_seconds<p_elapsed_seconds'),
    ("v_game.status='Final' OR ", ''),
    ('home_score=p_home_score,away_score=p_away_score', 'home_score=p_away_score,away_score=p_home_score'),
], [recipe('live-snapshot-order')])
sql(LIVE, 'public.save_game_stats_atomic', '(uuid,text,jsonb,boolean)', [
    ('points = EXCLUDED.points', 'points = stored.points'),
    ('v_game.nba_game_id IS DISTINCT FROM p_provider_game_id', 'false'),
    ('row.game_id IS DISTINCT FROM p_game_id', 'false'),
    ('IS DISTINCT FROM ROW(EXCLUDED.player_id', 'IS NOT DISTINCT FROM ROW(EXCLUDED.player_id'),
], [recipe('game-stats-completion')])
sql(LIVE, 'public.get_live_poll_work', '(timestamp with time zone)', [
    ("p_now+interval '2 minutes'", "p_now+interval '1 minute'"),
    ("attempt.stats_attempted_at <= p_now-interval '30 minutes'", "attempt.stats_attempted_at < p_now-interval '30 minutes'"),
    ('AND private.lineup_game_available(game.status,game.game_status_text)', ''),
    ("(p_now AT TIME ZONE 'America/New_York')::date-1", "(p_now AT TIME ZONE 'America/New_York')::date-2"),
], [recipe('live-ingestion-work')])
ts(LIVE, 'supabase/functions/_shared/gameProgress.ts', [
    ('period <= 4 ? 720 : 300', 'period <= 5 ? 720 : 300'),
    ('length - remaining', 'length + remaining'),
], [unit('gameProgress')])
ts(LIVE, 'hooks/use-matchup-data.ts', [
    ('eventTime < (eventTimes.get(row.id) ?? -Infinity)', 'eventTime > (eventTimes.get(row.id) ?? -Infinity)'),
], ['npx vitest run tests/hooks/matchup-realtime-boundary.test.ts'])
sql(WEEKLY, 'public.compute_fantasy_points', '(uuid,uuid)', [
    ('v_stats.did_not_play', 'NOT v_stats.did_not_play'),
    ('v_stats.points,                  0) *', 'v_stats.points,                  0) +'),
    ('v_stats.turnovers,               0) *', 'v_stats.turnovers,               0) +'),
], [db('scoring-corrections'), recipe('weekly-formula-boundaries')])
sql(WEEKLY, 'private.rebuild_regular_standings', '(uuid,uuid)', [
    ('result.winner_member_id = member.id', 'result.winner_member_id <> member.id'),
    ('result.winner_member_id IS NULL', 'result.winner_member_id IS NOT NULL'),
    ('result.week_number <= weeks.week_number', 'result.week_number < weeks.week_number'),
    ('THEN result.away_points ELSE result.home_points END', 'THEN result.home_points ELSE result.away_points END'),
], [recipe('skipped-week-certificates')])
ts(WEEKLY, 'supabase/functions/_shared/syncScores.ts', [
    ('if (homePoints > awayPoints) return matchup.home_member_id', 'if (homePoints < awayPoints) return matchup.home_member_id'),
    ('if (awayPoints > homePoints) return matchup.away_member_id', 'if (awayPoints < homePoints) return matchup.away_member_id'),
    ('toETDate(referenceDate) > endDate', 'toETDate(referenceDate) < endDate'),
    ('const maxPossiblePointsByMember = certifiedMaxPossiblePoints ?? new Map<string, number>()', 'const maxPossiblePointsByMember = new Map<string, number>()'),
], [unit('scoreCertifiedMax', 'finalizationWrite')])
ts(WEEKLY, 'supabase/functions/_shared/scoreLineups.ts', [
    (".neq('slot_type', 'BE')", ".neq('slot_type', 'UTIL')"),
    ('b.candidate.points - a.candidate.points', 'a.candidate.points - b.candidate.points'),
    ('(pointsByMember.get(row.member_id) ?? 0) +', '(pointsByMember.get(row.member_id) ?? 0) -'),
    ('best = Math.max(best, candidate.points +', 'best = Math.min(best, candidate.points +'),
], [unit('scoreLineupsBatch', 'scoreCertifiedMax')])
sql(WEEKLY, 'public.finalize_score_week_atomic', '(uuid,uuid,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)', [
    ('OR NOT private.lock_current_score_inputs', 'OR private.lock_current_score_inputs'),
    ('is_finalized = true', 'is_finalized = false'),
], [recipe('skipped-week-certificates')])
sql(WEEKLY, 'public.invoke_live_poll_if_due', '()', [
    ("PERFORM public.invoke_edge_function('sync-scores');", 'RETURN;'),
], [recipe('weekly-idle-dispatch')])
Path('scripts/mutation/live/catalog.json').write_text(json.dumps(rows, indent=2) + '\n')
print({area: sum(r['area'] == area for r in rows) for area in (LIVE, WEEKLY)})
