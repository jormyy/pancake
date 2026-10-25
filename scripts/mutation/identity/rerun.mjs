// Turn-10 identity reruns: the superseded-SQL verdicts R01-R05/T01-T03, a replacement for T02, the two
// identity-game-membership verdicts whose oracle changed (T04/T05), and new game-membership mutants GM01-GM04.
// Usage on an owned local stack: node scripts/mutation/identity/rerun.mjs <checkout sha> [mutations|scan]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ownedStack, rerunMutants, scanTargets } from './t10-rerun.mjs'

const [baseSha, mode = 'mutations'] = process.argv.slice(2)
const stack = ownedStack()
const psql = file => ({ name: file, kind: 'db-deployed', command: ['psql', stack.keys.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', file] })
const recipe = ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1,localhost,0.0.0.0', '--allow-read',
  '--allow-write=evidence', '--allow-run=psql', 'supabase/tests/db/identity-game-membership.ts']
const oracles = {
  'first-box': psql('tests/db/identity-first-box.sql'),
  'merge-support': psql('tests/db/identity-merge-support.sql'),
  'trade-locks': psql('tests/db/identity-nba-trade-locks.sql'),
  'game-membership': { name: 'evidence:db:identity-game-membership', kind: 'ts-module-db', command: recipe, display: 'npm run evidence:db:identity-game-membership' },
}
const resolver = 'public.resolve_player_imports_atomic(text,jsonb)'
const merge = 'public.merge_players(uuid,uuid)'
const lineup = 'private.lineup_game_started(uuid,date)'
const roster = 'private.roster_status_game_started(uuid)'
const membershipUnion = '    UNION\n    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id'
const r2 = { priorSha: '454cf583dbdf70c124100148939cd36c09b76e4e', priorOutcome: 'killed' }
const r3 = { priorSha: '141931ad', priorOutcome: 'killed' }
const mutants = [
  { id: 'R01', area: 'rookie-identity', symbol: resolver, operator: 'removed assignment', ...r2, oracle: 'first-box',
    original: 'UPDATE players SET nba_id = v_provider WHERE id = v_id', mutated: 'UPDATE players SET nba_id = nba_id WHERE id = v_id' },
  { id: 'R02', area: 'rookie-identity', symbol: resolver, operator: 'off-by-one constant', ...r2, oracle: 'first-box',
    original: 'nba_draft_number = v_pick,', mutated: 'nba_draft_number = v_pick + 1,' },
  { id: 'R04', area: 'rookie-identity', symbol: merge, operator: 'removed statement', ...r2, oracle: 'merge-support',
    original: 'UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;', mutated: '' },
  { id: 'R05', area: 'rookie-identity', symbol: merge, operator: 'removed statement', ...r2, oracle: 'merge-support',
    original: 'UPDATE fantasypros_projection_rows SET player_id = winner_id WHERE player_id = loser_id;', mutated: '' },
  { id: 'T01', area: 'nba-trades', symbol: lineup, operator: 'negate condition', ...r2, oracle: 'trade-locks',
    original: 'AND NOT EXISTS (', mutated: 'AND EXISTS (' },
  { id: 'T02', area: 'nba-trades', symbol: roster, operator: 'removed predicate', ...r2, oracle: 'trade-locks',
    original: 'OR EXISTS (\n          SELECT 1 FROM player_game_stats AS stats\n          WHERE stats.player_id = p.id AND stats.game_id = g.id\n        )',
    mutated: 'OR FALSE', nearest: 'migration 20261020000131 reads stats and verified memberships through the participation CTE: "OR EXISTS (SELECT 1 FROM participation AS stats WHERE stats.game_id = g.id)"; replacement T02R' },
  { id: 'T02R', area: 'nba-trades', symbol: roster, operator: 'removed predicate', priorSha: null, priorOutcome: null, oracle: 'trade-locks',
    original: 'OR EXISTS (\n          SELECT 1 FROM participation AS stats\n          WHERE stats.game_id = g.id\n        )', mutated: 'OR FALSE',
    notes: 'Replacement for T02 (target-removed): same intent (a stale-team player who already appeared in another team game stays locked) and operator class on the current definition.' },
  { id: 'T03', area: 'nba-trades', symbol: lineup, operator: 'relational <= to >', ...r2, oracle: 'trade-locks',
    original: 'g.game_time <= now()', mutated: 'g.game_time > now()' },
  { id: 'T04', area: 'nba-trades', file: 'supabase/functions/_shared/syncStats.ts', function: 'resolveBoxScorePlayers', operator: 'removed argument', ...r3,
    oracle: 'game-membership', original: '  })), providerGameId)', mutated: '  })))',
    notes: 'Target unchanged since its measurement; rerun because turn 11 changed its oracle (identity-game-membership no longer binds 57721/57722/57780).' },
  { id: 'T05', area: 'nba-trades', symbol: roster, operator: 'removed UNION branch', ...r3, oracle: 'game-membership', original: membershipUnion, mutated: '',
    notes: 'Target unchanged since its measurement; rerun because turn 11 changed its oracle.' },
  { id: 'GM01', area: 'nba-trades', symbol: resolver, operator: 'negate condition', priorSha: null, priorOutcome: null, oracle: 'game-membership',
    original: 'IF v_game_id IS NOT NULL THEN\n            INSERT INTO private.player_game_memberships(player_id, game_id)',
    mutated: 'IF v_game_id IS NULL THEN\n            INSERT INTO private.player_game_memberships(player_id, game_id)',
    notes: 'New game-membership mutant: the first verified box no longer records the membership.' },
  { id: 'GM02', area: 'nba-trades', symbol: resolver, operator: 'conflict action: keep first sighting -> overwrite with latest', priorSha: null, priorOutcome: null, oracle: 'game-membership',
    original: 'VALUES (v_id, v_game_id) ON CONFLICT (player_id, game_id) DO NOTHING;',
    mutated: 'VALUES (v_id, v_game_id) ON CONFLICT (player_id, game_id) DO UPDATE SET first_seen_at = clock_timestamp();',
    notes: 'New game-membership mutant: a repeated poll moves first_seen_at.' },
  { id: 'GM03', area: 'nba-trades', symbol: merge, operator: 'LEAST -> GREATEST', priorSha: null, priorOutcome: null, oracle: 'game-membership',
    original: 'SET first_seen_at = LEAST(player_game_memberships.first_seen_at, EXCLUDED.first_seen_at);',
    mutated: 'SET first_seen_at = GREATEST(player_game_memberships.first_seen_at, EXCLUDED.first_seen_at);',
    notes: 'New game-membership mutant: a merge keeps the later sighting.' },
  { id: 'GM04', area: 'nba-trades', symbol: lineup, operator: 'removed UNION branch', priorSha: null, priorOutcome: null, oracle: 'game-membership',
    original: membershipUnion, mutated: '',
    notes: 'New game-membership mutant: lineup locks ignore verified memberships (mirror of T05 on the lineup lock).' },
]
const evidence = resolve(process.env.T10_EVIDENCE ?? 'evidence/t10/ident')
if (mode === 'scan') {
  // Turn-9 rank/projection and older ident targets: confirm each still targets the deployed or checked-out source.
  mkdirSync(evidence, { recursive: true })
  const scan = scanTargets(stack, [
    { id: 'R03', symbol: 'public.assign_player_nba_id_atomic(uuid,text)', file: 'supabase/migrations/20261011000052_resolve_player_imports_atomically.sql', original: 'UPDATE players SET nba_id = p_nba_id WHERE id = p_player_id;' },
    { id: 'L01', symbol: resolver, file: 'supabase/migrations/20261020000132_order_player_import_locks.sql', original: '    ORDER BY p.id FOR UPDATE;' },
    { id: 'L02', symbol: resolver, file: 'supabase/migrations/20261020000132_order_player_import_locks.sql', original: "    PERFORM g.id FROM nba_games AS g\n      WHERE g.nba_game_id IN (SELECT r->>'nba_game_id' FROM jsonb_array_elements(" },
    { id: 'L03', file: 'supabase/functions/_shared/playerImports.ts', original: "['40P01', '40001'].includes(response.error.code)" },
    { id: 'L04', file: 'supabase/functions/_shared/playerImports.ts', original: 'retry < 3' },
    { id: 'W01', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: '  INSERT INTO player_watches(league_id, member_id, player_id, created_at)\n    SELECT league_id, member_id, winner_id,' },
    { id: 'W02', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: '    ON CONFLICT (member_id, player_id) DO NOTHING;' },
    { id: 'P01', file: 'supabase/functions/sync-projections/index.ts', original: 'const LOOKBACK_WEEKS = 4' },
    { id: 'P02', file: 'supabase/functions/sync-projections/index.ts', original: '    if (stat.did_not_play) continue' },
    { id: 'P03', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: '  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;' },
    { id: 'P04', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: '  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;' },
    { id: 'RR01', file: 'supabase/functions/sync-rankings/match.ts', original: 'player_id: player?.id ?? null,' },
    { id: 'RR02', file: 'supabase/functions/sync-rankings/match.ts', original: 'maps.byNormName.get(normalizeName(name))' },
    { id: 'RR03', file: 'supabase/functions/sync-rankings/match.ts', original: 'source_rank: ranking.rank,' },
    { id: 'RR04', file: 'supabase/functions/sync-rankings/match.ts', original: 'rank_change: ranking.rankChange,' },
    { id: 'RR05', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: '  UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;' },
    { id: 'RR06', symbol: merge, file: 'supabase/migrations/20261020000250_transfer_player_watches_on_merge.sql', original: 'dynasty_rank = COALESCE(v_winner.dynasty_rank, v_loser.dynasty_rank),' },
  ])
  writeFileSync(join(evidence, 'target-scan.json'), JSON.stringify({ baseSha, scan }, null, 2) + '\n')
  console.log(JSON.stringify(scan))
} else {
  const rows = rerunMutants({ lane: 'claude-gaps', mutants, oracles, evidence, baseSha, stack })
  if (rows.some(row => row.outcome === 'survived')) process.exitCode = 1
}
