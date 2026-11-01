import { supabase } from './supabase.ts'
import type { Json } from './database.ts'

export type LiveFeedSnapshot = {
  source: 'nba' | 'espn'
  source_updated_at: string
  elapsed_seconds: number
  stats?: Json
  full_stats?: Json
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

export type LiveGameCache = {
  snapshot?: LiveFeedSnapshot | null
  players?: { provider_id: string; player_id: string; nba_team: string }[]
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => key !== 'updated_at' && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, comparable(item)]),
  )
  return value
}

export function liveSnapshotKey(snapshot: unknown): string {
  return JSON.stringify(comparable(snapshot))
}

export function changedLiveStats(snapshot: LiveFeedSnapshot, previous?: LiveFeedSnapshot | null): Json[] {
  const rows = (snapshot.stats ?? []) as Json[]
  if (!previous || previous.source !== snapshot.source) return rows
  const stored = new Map(((previous.stats ?? []) as { player_id: string }[])
    .map(row => [row.player_id, liveSnapshotKey(row)]))
  return rows.filter(row => stored.get((row as { player_id: string }).player_id) !== liveSnapshotKey(row))
}
