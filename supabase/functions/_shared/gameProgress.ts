export function gameElapsedSeconds(game: { gameStatus: number; period?: number; gameClock?: string }): number {
  if (game.gameStatus === 1) return 0
  const period = game.period ?? 0
  const clock = /^PT(\d+)M([\d.]+)S$/.exec(game.gameClock ?? '')
  if (!Number.isInteger(period) || period < 1 || !clock) throw new Error('Live game progress is missing or invalid')
  const remaining = Number(clock[1]) * 60 + Number(clock[2])
  const length = period <= 4 ? 720 : 300
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > length) throw new Error('Live game clock is outside its period')
  return Math.min(period - 1, 4) * 720 + Math.max(period - 5, 0) * 300 + length - remaining
}
