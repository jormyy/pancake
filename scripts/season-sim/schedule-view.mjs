import { etDate } from './common.mjs'

export function scheduleObservation(game, postponed, bounds, at) {
  const today = etDate(new Date(at).toISOString())
  const pending = postponed && today <= postponed.date
  const date = pending ? postponed.date : game.date
  return {
    gameId: game.id,
    weekNumber: Math.floor((Date.parse(date) - Date.parse('2025-10-20')) / 604800000) + 1,
    gameDateEst: date,
    gameDateTimeUTC: pending ? postponed.time : game.time,
    gameStatus: at >= bounds.end ? 3 : at >= bounds.start ? 2 : 1,
    gameStatusText: pending && today === postponed.date ? 'Postponed' : at >= bounds.end ? 'Final' : at >= bounds.start ? 'In Progress' : 'Scheduled',
    homeTeam: { teamTricode: game.home },
    awayTeam: { teamTricode: game.away },
  }
}
