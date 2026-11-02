import { supabase } from './supabase.ts'
import type { Json } from './database.ts'

export type LiveFeedSnapshot = {
  source: 'nba' | 'espn'
  source_updated_at: string
  elapsed_seconds: number
  stats?: Json
  nba_witness_player_ids?: string[]
  status?: string
  home_score?: number
  away_score?: number
  status_text?: string
}

type FeedRpc = (name: 'save_live_feed_snapshot_atomic', args: { p_game_id: string; p_provider_game_id: string; p_snapshot: Json }) => {
  abortSignal(signal: AbortSignal): PromiseLike<{ data: number | null; error: unknown }>
}

export async function saveLiveFeedSnapshot(gameId: string, providerId: string, snapshot: LiveFeedSnapshot): Promise<number> {
  const rpc = supabase.rpc.bind(supabase) as unknown as FeedRpc
  const { data, error } = await rpc('save_live_feed_snapshot_atomic', {
    p_game_id: gameId, p_provider_game_id: providerId, p_snapshot: snapshot,
  }).abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
  return data ?? 0
}
