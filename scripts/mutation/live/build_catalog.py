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
    prefix = 'L' if area == LIVE else 'live-sw-' if area == 'skipped-week' else 'W'
    rows.append(dict(id=prefix + str(1 + sum(r['area'] == area for r in rows)).zfill(2), area=area, file=file, line=line, symbol=symbol, operator=operator, original=original, mutated=mutated, oracles=oracles))


def sql(area, name, signature, changes, oracles, operator='condition'):
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
        add(area, str(path), source.count('\n', 0, source.index(original, start)) + 1, name + signature, original, mutated, oracles, operator)


def ts(area, file, changes, oracles, operator='condition'):
    source = Path(file).read_text()
    for original, mutated in changes:
        if source.count(original) != 1:
            raise ValueError((file, original))
        add(area, file, source.count('\n', 0, source.index(original)) + 1, file, original, mutated, oracles, operator)


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
sql(LIVE, 'public.update_score_points_atomic', '(uuid,uuid,integer,jsonb)', [
    ('AND NOT private.playoff_matchup_is_consumed(matchup.id)', ''),
    ("AND (matchup.matchup_type = 'regular_season' OR matchup.is_finalized IS NOT TRUE)", ''),
    ('AND (matchup.home_points IS DISTINCT FROM requested.home_points OR matchup.away_points IS DISTINCT FROM requested.away_points)', ''),
], [recipe('live-score-guards')])
sql(LIVE, 'public.update_score_points_atomic', '(uuid,uuid,integer,jsonb)', [
    ('OR NOT private.lock_current_score_inputs(p_league_season_id, p_week_number, v_input_token)', 'OR false'),
], [db('live-score-overlap')])
sql(LIVE, 'public.save_live_scoreboard_atomic', '(uuid,text,text,integer,integer,text,numeric)', [
    ("OR (v_game.status='InProgress' AND p_status='Scheduled')", ''),
    ('v_game.live_scoreboard_elapsed_seconds>p_elapsed_seconds', 'v_game.live_scoreboard_elapsed_seconds>=p_elapsed_seconds'),
    ('v_game.nba_game_id IS DISTINCT FROM p_provider_game_id', 'false'),
], [recipe('live-snapshot-order')])
sql(LIVE, 'public.save_live_game_stats_atomic', '(uuid,text,jsonb,numeric)', [
    ('v_game.nba_game_id IS DISTINCT FROM p_provider_game_id', 'false'),
], [recipe('live-snapshot-order')])
ts(LIVE, 'hooks/use-matchup-data.ts', [
    ('eventTimes.set(row.id, eventTime)', 'eventTimes.delete(row.id)'),
    ('eventTime < (eventTimes.get(row.id) ?? -Infinity)', 'eventTime <= (eventTimes.get(row.id) ?? -Infinity)'),
], ['npx vitest run tests/hooks/matchup-realtime-boundary.test.ts'])
ts(LIVE, 'supabase/functions/_shared/syncScores.ts', [
    ('input_token: liveInputToken,', ''),
], [db('live-score-overlap')])
sql(WEEKLY, 'public.invoke_live_poll_if_due', '()', [
    ("league.status IN ('active', 'playoffs')", "league.status = 'active'"),
    ("interval '30 minutes'", "interval '5 minutes'"),
    ('final.is_finalized AND NOT final.is_voided', 'NOT final.is_finalized AND NOT final.is_voided'),
    ('certificate.input_token IS DISTINCT FROM CASE', 'certificate.input_token IS NOT DISTINCT FROM CASE'),
], [recipe('weekly-idle-dispatch')])
sql(WEEKLY, 'public.invoke_live_poll_if_due', '()', [
    ('::int <= candidate.week_number', '::int < candidate.week_number'),
], [recipe('weekly-idle-dispatch')], 'ROR')
sql(WEEKLY, 'public.invoke_live_poll_if_due', '()', [
    ('CASE WHEN NOT EXISTS (', 'CASE WHEN EXISTS ('),
], [recipe('weekly-idle-dispatch')], 'NEG')
sql('skipped-week', 'public.update_score_points_atomic', '(uuid,uuid,integer,jsonb)', [
    ('p_week_number=ANY(skipped_weeks)', 'p_week_number<>ALL(skipped_weeks)'),
], [db('scoring-skip-first-week')], 'NEG')
sql('skipped-week', 'public.update_score_points_atomic', '(uuid,uuid,integer,jsonb)', [
    ('p_week_number=ANY(skipped_weeks)', '(p_week_number+1)=ANY(skipped_weeks)'),
], [db('scoring-skip-first-week')], 'CONST')
sql('skipped-week', 'public.finalize_score_week_atomic', '(uuid,uuid,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)', [
    ('p_week_number=ANY(skipped_weeks)', 'p_week_number<>ALL(skipped_weeks)'),
], [db('scoring-skip-first-week')], 'NEG')
sql('skipped-week', 'public.finalize_score_week_atomic', '(uuid,uuid,integer,jsonb,jsonb,timestamp with time zone,timestamp with time zone)', [
    ("IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_league_season_id AND p_week_number=ANY(skipped_weeks)) THEN RETURN '[]'::jsonb; END IF;", ''),
], [db('scoring-skip-first-week')], 'STMT-DEL')
sql('skipped-week', 'public.invoke_live_poll_if_due', '()', [
    ('AND NOT (matchup.week_number = ANY(season.skipped_weeks))', 'AND (matchup.week_number = ANY(season.skipped_weeks))'),
], [recipe('weekly-skip-idle')], 'NEG')
sql('skipped-week', 'private.rebuild_regular_standings', '(uuid,uuid)', [
    ('AND result.is_finalized AND NOT result.is_voided', 'AND result.is_finalized'),
], [db('scoring-skip-first-week')], 'STMT-DEL')
sql('skipped-week', 'private.enforce_skipped_matchup', '()', [
    ('NEW.week_number = ANY(skipped_weeks)', 'NEW.week_number <> ALL(skipped_weeks)'),
], [db('scoring-skip-first-week')], 'NEG')
ts(LIVE, 'supabase/functions/_shared/syncScores.ts', [
    ("updateErr.code === 'PT409'", "updateErr.code !== 'PT409'"),
], [unit('scoreCertifiedMax')], 'NEG')
ts(LIVE, 'supabase/functions/_shared/syncScores.ts', [
    ("updateErr.code === 'PT409' &&", "updateErr.code === 'PT409' ||"),
], [unit('scoreCertifiedMax')], 'LCR')
ts(LIVE, 'supabase/functions/_shared/syncScores.ts', [
    ('onPublicationRetry()', ''),
], [unit('scoreCertifiedMax')], 'STMT-DEL')
sql(LIVE, 'public.get_live_poll_work', '(timestamp with time zone)', [
    ("BETWEEN p_now-interval '45 minutes'", "BETWEEN p_now-interval '10 minutes'"),
    ("BETWEEN p_now-interval '45 minutes'", "BETWEEN p_now-interval '44 minutes'"),
], [recipe('live-poll-delayed-tipoff')], 'CONST')
sql(LIVE, 'public.get_live_poll_work', '(timestamp with time zone)', [
    ("COALESCE(game.game_time,game.started_at) < p_now-interval '45 minutes'", "COALESCE(game.game_time,game.started_at) > p_now-interval '45 minutes'"),
    ("attempt.checked_at <= p_now-interval '30 minutes'", "attempt.checked_at < p_now-interval '30 minutes'"),
], [recipe('live-poll-delayed-tipoff')], 'ROR')
sql(LIVE, 'public.get_live_poll_work', '(timestamp with time zone)', [
    ("attempt.checked_at <= p_now-interval '30 minutes'", "attempt.checked_at <= p_now-interval '2 minutes'"),
], [recipe('live-poll-delayed-tipoff')], 'CONST')
worker_oracle = ['deno test --no-lock --node-modules-dir=none supabase/functions/live-poll/policy.test.ts']
ts(LIVE, 'supabase/functions/live-poll/policy.ts', [
    ("game.status === 'Scheduled' && game.needs_scoreboard", "game.status === 'Scheduled' || game.needs_scoreboard"),
], worker_oracle, 'LCR')
ts(LIVE, 'supabase/functions/live-poll/policy.ts', [
    ('&& game.needs_scoreboard', '&& !game.needs_scoreboard'),
], worker_oracle, 'NEG')
ts(LIVE, 'supabase/functions/live-poll/policy.ts', [
    ("game.status === 'InProgress'", "game.status === 'Final'"),
], worker_oracle, 'CONST')
legacy_operators = {
    'L': ['ROR', 'STMT-DEL', 'ROR', 'ROR', 'STMT-DEL', 'ARG-SWAP', 'ARG-SWAP', 'CONST', 'CONST', 'NEG',
          'CONST', 'ROR', 'STMT-DEL', 'CONST', 'CONST', 'AOR', 'ROR', 'STMT-DEL', 'STMT-DEL', 'STMT-DEL',
          'CONST', 'STMT-DEL', 'ROR', 'CONST', 'CONST', 'STMT-DEL', 'ROR', 'STMT-DEL'],
    'W': ['NEG', 'AOR', 'AOR', 'ROR', 'NEG', 'ROR', 'ARG-SWAP', 'ROR', 'ROR', 'ROR', 'STMT-DEL',
          'CONST', 'ORDER', 'AOR', 'AOR', 'NEG', 'NEG', 'STMT-DEL', 'CONST', 'CONST', 'NEG', 'NEG'],
}
for row in rows:
    match = re.fullmatch(r'([LW])(\d+)', row['id'])
    if match and int(match[2]) <= len(legacy_operators[match[1]]):
        row['operator'] = legacy_operators[match[1]][int(match[2]) - 1]
Path('scripts/mutation/live/catalog.json').write_text(json.dumps(rows, indent=2) + '\n')
print({area: sum(r['area'] == area for r in rows) for area in (LIVE, WEEKLY, 'skipped-week')})
