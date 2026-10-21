import { etDate, season } from './common.mjs'
import { monday } from './season-model.mjs'

export function scheduleObservation(game, postponed, bounds, at, metadata = {}) {
  const today = etDate(new Date(at).toISOString())
  const original = postponed?.originalDate ?? postponed?.date
  const pending = postponed && (postponed.rescheduledAt == null ? today <= original : at < postponed.rescheduledAt)
  const unavailable = pending && (postponed.postponedAt == null ? today === original : at >= postponed.postponedAt)
  const date = pending ? original : game.date
  return {
    gameId: game.id,
    weekNumber: !pending && metadata.weekNumber != null ? metadata.weekNumber : Math.floor((Date.parse(date) - Date.parse(monday(metadata.opening ?? season.start))) / 604800000) + 1,
    gameDateEst: date,
    gameDateTimeUTC: pending ? postponed.originalTime ?? postponed.time : game.time,
    postponedStatus: unavailable ? 'Y' : 'N',
    gameLabel: metadata.gameLabel ?? '',
    gameSubtype: metadata.gameSubtype ?? '',
    gameStatus: at >= bounds.end ? 3 : at >= bounds.start ? 2 : 1,
    gameStatusText: unavailable ? 'Postponed' : at >= bounds.end ? 'Final' : at >= bounds.start ? 'In Progress' : 'Scheduled',
    homeTeam: { teamTricode: game.home },
    awayTeam: { teamTricode: game.away },
  }
}
