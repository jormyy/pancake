type PollGame = { status: string; needs_scoreboard: boolean }

export function shouldKeepPolling(work: PollGame[]): boolean {
  return work.some(game => game.status === 'InProgress' ||
    (game.status === 'Scheduled' && game.needs_scoreboard))
}
