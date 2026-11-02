import { gameElapsedSeconds } from './gameProgress.ts'
import type { NBABoxScore, NBAGame } from './nba.ts'

export function newerNbaSource(nba: NBABoxScore | undefined, espn: NBAGame): boolean {
  if (!nba) return false
  if (nba.gameStatus === 3) return true
  if (nba.gameStatus !== 2) return false
  const timestamp = nba.liveSourceUpdatedAt ?? nba.sourceUpdatedAt
  return (timestamp ? Date.parse(timestamp) : NaN) >= Date.parse(espn.sourceUpdatedAt ?? '')
    || gameElapsedSeconds(nba) > gameElapsedSeconds(espn)
}
