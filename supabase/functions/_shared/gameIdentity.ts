import { supabase } from './supabase.ts'

type GameIdentity = {
  nba_game_id: string
  season_year: number
  game_date: string
  home_team: string
  away_team: string
}

export async function assertGameImports(games: GameIdentity[]): Promise<void> {
  const { error } = await supabase.rpc('assert_nba_game_imports', { p_games: games })
  if (error) throw error
}

export async function assertGameUnambiguous(gameId: string): Promise<void> {
  const { error } = await supabase.rpc('assert_nba_game_unambiguous', { p_game_id: gameId })
  if (error) throw error
}
