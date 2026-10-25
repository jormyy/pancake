import json
from pathlib import Path

catalog = Path('scripts/mutation/live/catalog.json')
rows = json.loads(catalog.read_text())
oracle = 'deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/scoring-eliminated-lineups.ts 2024 full'


def add(number, file, symbol, operator, original, mutated):
    source = Path(file).read_text()
    assert source.count(original) == 1, (number, source.count(original))
    identifier = f'live-elim-{number:02d}'
    row = dict(id=identifier, area='weekly-scoring', file=file,
               line=source[:source.index(original)].count('\n') + 1, symbol=symbol,
               operator=operator, original=original, mutated=mutated, oracles=[oracle])
    rows[:] = [entry for entry in rows if entry['id'] != identifier]
    rows.append(row)


sql = 'supabase/migrations/20261020000036_skip_unchanged_score_finalization.sql'
symbol = 'public.finalize_score_week_atomic(uuid,uuid,int,jsonb,jsonb,timestamptz,timestamptz)'
add(1, sql, symbol, 'STMT-DEL', '''       AND (NOT locked.is_finalized
         OR (locked.home_points, locked.away_points, locked.winner_member_id,
           locked.home_max_possible_points, locked.away_max_possible_points) IS DISTINCT FROM
           (COALESCE(locked.requested_home_points, locked.home_points),
             COALESCE(locked.requested_away_points, locked.away_points), locked.requested_winner_member_id,
             locked.requested_home_max_possible_points, locked.requested_away_max_possible_points))''', '')
add(2, sql, symbol, 'STMT-DEL', '''
  WHERE (standings.wins, standings.losses, standings.ties, standings.points_for, standings.points_against,
    standings.max_possible_points, standings.waiver_priority) IS DISTINCT FROM
    (EXCLUDED.wins, EXCLUDED.losses, EXCLUDED.ties, EXCLUDED.points_for, EXCLUDED.points_against,
      EXCLUDED.max_possible_points, EXCLUDED.waiver_priority)''', '')
add(3, 'supabase/functions/_shared/syncScores.ts', 'buildStandingsSnapshotRows', 'STMT-DEL', '''const regularSeasonMatchups = matchups.filter(
        (m) => m.matchup_type === 'regular_season',
    )''', 'const regularSeasonMatchups = matchups')
add(4, 'supabase/functions/_shared/scoreLineups.ts', 'calcWeekMaxPossiblePointsByMember', 'ROR',
    'if (eligiblePositions.length === 0) continue', 'if (eligiblePositions.length !== 0) continue')
add(5, sql, symbol, 'STMT-DEL',
    '\n    WHERE score_week_certificates.input_token IS DISTINCT FROM EXCLUDED.input_token', '')
rows[-1]['oracles'] = ['psql "$SUPABASE_DB_URL" -X --set ON_ERROR_STOP=1 -f tests/db/scoring-idempotent-finalization.sql']
catalog.write_text(json.dumps(rows, indent=2) + '\n')
