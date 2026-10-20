// The generated syncScores module builds a Supabase client at import time, so
// point it at a placeholder; nothing here touches the network.
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')

const { finalizationWriteNeeded, resolveMatchupWinnerForScore } = await import('./syncScores.ts')

const HOME = '00000000-0000-4000-8000-00000000000a'
const AWAY = '00000000-0000-4000-8000-00000000000b'

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    is_finalized: true,
    winner_member_id: HOME,
    home_max_possible_points: '120.50',
    away_max_possible_points: '99',
    winnerId: HOME,
    homeMaxPossiblePoints: 120.5,
    awayMaxPossiblePoints: 99,
    ...overrides,
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

Deno.test('an unfinalized matchup is always written', () => {
  assert(finalizationWriteNeeded(candidate({ is_finalized: false })), 'unfinalized must write')
  assert(finalizationWriteNeeded(candidate({ is_finalized: null })), 'null is_finalized must write')
})

// The regression: a closed playoff round re-synced every live-poll tick for the
// following week. Unchanged decisions must preserve finalized_at so the
// 48h boundary grace can elapse while the read boundary advances.
Deno.test('a finalized matchup with an unchanged decision keeps its grace timestamp', () => {
  assert(!finalizationWriteNeeded(candidate()), 'unchanged decision must not write')
})

Deno.test('numeric formatting alone is not a change', () => {
  assert(!finalizationWriteNeeded(candidate({ home_max_possible_points: 120.5, away_max_possible_points: '99.00' })), 'format-only differences must not write')
})

Deno.test('an in-window correction that flips the winner is written', () => {
  assert(finalizationWriteNeeded(candidate({ winnerId: AWAY })), 'winner change must write')
  assert(finalizationWriteNeeded(candidate({ winner_member_id: null })), 'winner appearing must write')
})

Deno.test('a change in max-possible points is written', () => {
  assert(finalizationWriteNeeded(candidate({ homeMaxPossiblePoints: 121 })), 'home max change must write')
  assert(finalizationWriteNeeded(candidate({ away_max_possible_points: null })), 'missing stored max must write')
})

Deno.test('regular scores select either winner and preserve ties regardless of maxima', () => {
  const matchup = { matchup_type: 'regular_season', home_member_id: HOME, away_member_id: AWAY }
  assert(resolveMatchupWinnerForScore(matchup, 12, 8, 1, 100) === HOME, 'home win')
  assert(resolveMatchupWinnerForScore(matchup, 8, 12, 100, 1) === AWAY, 'away win')
  assert(resolveMatchupWinnerForScore(matchup, 12, 12, 100, 1) === null, 'regular tie')
  assert(resolveMatchupWinnerForScore(matchup, -1, -2, 0, 0) === HOME, 'negative scores')
})

Deno.test('playoff ties use maxima and then the home seed', () => {
  for (const matchup_type of ['playoff_quarterfinal', 'playoff_semifinal', 'playoff_final']) {
    const matchup = { matchup_type, home_member_id: HOME, away_member_id: AWAY }
    assert(resolveMatchupWinnerForScore(matchup, 12, 12, 100, 99) === HOME, 'home max wins')
    assert(resolveMatchupWinnerForScore(matchup, 12, 12, 99, 100) === AWAY, 'away max wins')
    assert(resolveMatchupWinnerForScore(matchup, 12, 12, 100, 100) === HOME, 'home seed wins complete tie')
  }
})
