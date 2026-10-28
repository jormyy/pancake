type Game = { id: string; game_time?: string | null }

export async function withGameTimes(view: Record<string, unknown>, load: (ids: string[]) => Promise<Game[]>) {
  const games = (view.todaysGames ?? []) as Game[]
  const missing = games.filter(game => !Object.hasOwn(game, 'game_time'))
  if (!missing.length) return view
  const times = new Map((await load(missing.map(game => game.id))).map(game => [game.id, game.game_time ?? null]))
  return { ...view, todaysGames: games.map(game => Object.hasOwn(game, 'game_time') ? game : { ...game, game_time: times.get(game.id) ?? null }) }
}
