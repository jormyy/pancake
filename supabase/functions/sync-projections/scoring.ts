import { roundFantasyPoints, type ScoringSettings } from '../_shared/scoringCore.ts'
import type { FantasyProsProjectionStats } from './parser.ts'

export function calculateProjectionFantasyPoints(
  stats: Pick<
    FantasyProsProjectionStats,
    'points' | 'rebounds' | 'assists' | 'steals' | 'blocks' | 'three_pointers_made' | 'turnovers'
  >,
  scoring: ScoringSettings,
): number {
  return roundFantasyPoints(
    Number(stats.points ?? 0) * (scoring.points ?? 0) +
      Number(stats.rebounds ?? 0) * (scoring.rebounds ?? 0) +
      Number(stats.assists ?? 0) * (scoring.assists ?? 0) +
      Number(stats.steals ?? 0) * (scoring.steals ?? 0) +
      Number(stats.blocks ?? 0) * (scoring.blocks ?? 0) +
      Number(stats.three_pointers_made ?? 0) * (scoring.three_pointers_made ?? 0) +
      Number(stats.turnovers ?? 0) * (scoring.turnovers ?? 0),
  )
}
