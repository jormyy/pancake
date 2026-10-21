// Players-sort reruns: the seven round-1 search_players mutants (W/evidence/players/run-mutations.txt, measured on
// migration 20261020000230) retargeted at the deployed search_players definition, with the same operators and
// the same oracle, tests/db/players-fp-season.sql. Mode f7-browser runs the F7 compact-UI browser mutants (f7-browser.mjs).
// Usage on an owned local stack: node scripts/mutation/players/rerun.mjs <checkout sha> [mutations|f7-browser]
import { resolve } from 'node:path'
import { ownedStack, rerunMutants } from '../identity/t10-rerun.mjs'

const [baseSha, mode = 'mutations'] = process.argv.slice(2)
const stack = ownedStack()
const evidence = resolve(process.env.T10_EVIDENCE ?? 'evidence/t10/players')
const symbol = 'public.search_players(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer)'
const prior = { priorSha: '141931ad', priorOutcome: 'killed' }
const oracles = {
  'players-fp-season': { name: 'players-fp-season', kind: 'db-deployed', command: ['psql', stack.keys.DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/players-fp-season.sql'] },
}
const mutants = [
  ['final-negated', 'relational = to <>', "g.status = 'Final'", "g.status <> 'Final'"],
  ['include-exhibitions', 'remove regular-season predicate', "    AND public.is_regular_season_game_id(g.nba_game_id)\n    AND (g.status = 'Final' OR EXISTS (", "    AND true\n    AND (g.status = 'Final' OR EXISTS (",
    'Migration 20261020000231 added a second is_regular_season_game_id predicate (current_averages join); the original is anchored to the started-season switch it targeted in 230. Same replaced token.'],
  ['wrong-fallback-season', 'off-by-one season', 'ELSE v_current_season - 1 END', 'ELSE v_current_season END'],
  ['missing-first', 'NULLS LAST to NULLS FIRST', 'THEN filtered_base.avg_fantasy_points END DESC NULLS LAST', 'THEN filtered_base.avg_fantasy_points END DESC NULLS FIRST'],
  ['zero-for-missing', 'null handling COALESCE(value, 0)', 'THEN filtered_base.avg_fantasy_points END ASC NULLS LAST', 'THEN COALESCE(filtered_base.avg_fantasy_points, 0) END ASC NULLS LAST'],
  ['wrong-label-season', 'returned season + 1', '  v_stats_season\nFROM paged_base', '  v_stats_season + 1\nFROM paged_base'],
  ['final-and-stats', 'OR to AND', "g.status = 'Final' OR EXISTS", "g.status = 'Final' AND EXISTS"],
].map(([id, operator, original, mutated, notes]) => ({ id, area: 'players-sort', symbol, operator, original, mutated, oracle: 'players-fp-season', ...prior,
  notes: notes ?? 'Prior verdict targeted migration 20261020000230; the current definition is 20261020000231. Same operator, original text and oracle.' }))
if (mode === 'f7-browser') {
  const { runF7Browser } = await import('./f7-browser.mjs')
  const rows = await runF7Browser({ baseSha, evidence, stack })
  if (rows.some(row => row.outcome !== 'killed')) process.exitCode = 1
} else {
  const rows = rerunMutants({ lane: 'claude-gaps', mutants, oracles, evidence, baseSha, stack })
  if (rows.some(row => row.outcome === 'survived')) process.exitCode = 1
}
