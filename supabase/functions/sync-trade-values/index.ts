import { supabase } from '../_shared/supabase.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { cachedTradeValueSnapshot, syncTradeValues, type TradeValueStore } from '../_shared/tradeValues.ts'
import type { TradeValuePlayer } from '../_shared/tradeValues.ts'

type Result = { data: unknown; error: unknown }
const rpc = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
  const result: Result = await (supabase.rpc as unknown as (name: string, args: Record<string, unknown>) => { abortSignal: (signal: AbortSignal) => Promise<Result> })(name, args).abortSignal(signal)
  if (result.error) throw result.error
  return result.data
}

const store: TradeValueStore = {
  claim: async (requestId, signal) => await rpc('claim_trade_value_sync', { p_request_id: requestId }, signal) === true,
  fail: async (requestId, retry, retryDate, scheduleRetry, signal) => await rpc('fail_trade_value_sync', { p_request_id: requestId, p_retry: retry, p_retry_date: retryDate, p_schedule_retry: scheduleRetry }, signal),
  cached: async signal => {
    const state = await rpc('get_trade_value_sync_state', {}, signal) as { fetched_at: string | null; last_request_at: string | null; matched: number | null }
    return cachedTradeValueSnapshot(state)
  },
  players: async signal => {
    const players: TradeValuePlayer[] = []
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase.from('players').select('id,display_name,nba_team,position,eligible_positions').order('id').range(start, start + 999).abortSignal(signal)
      if (error) throw error
      players.push(...data)
      if (data.length < 1000) return players
    }
  },
  overrides: async signal => {
    const rows = await rpc('trade_value_review_overrides', {}, signal) as { source_id: string; resolved_player_id: string }[]
    return Object.fromEntries(rows.map(row => [row.source_id, row.resolved_player_id]))
  },
  publish: async (payload, signal) => await rpc('publish_trade_values', { p_rows: payload.rows, p_picks: payload.picks,
    p_source_body: payload.source, p_fetched_at: payload.fetchedAt, p_mode: payload.mode, p_request_id: payload.requestId }, signal) as Record<string, unknown>,
}

serveInternal('sync-trade-values', async request => {
  const input = request.method === 'POST' ? await request.json() : {}
  const result = await recordSyncRun('sync-trade-values', async () => {
    const result = await syncTradeValues(store, input)
    return { result, rowsAffected: 'cached' in result ? 0 : 468 }
  }, request)
  return Response.json({ ok: true, result })
})
