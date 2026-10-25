import { supabase } from './supabase.ts'

export async function activateLeagueAfterTrade(tradeId: string): Promise<void> {
  const { data: trade, error: tradeError } = await supabase.from('trades')
    .select('league_id,league_season_id,leagues!inner(status)')
    .eq('id', tradeId).eq('status', 'completed').eq('leagues.status', 'drafting').maybeSingle()
  if (tradeError) throw tradeError
  if (!trade) return
  const { data: draft, error: draftError } = await supabase.from('drafts').select('id')
    .eq('league_id', trade.league_id).eq('league_season_id', trade.league_season_id)
    .eq('draft_type', 'snake').eq('is_mock', false).eq('status', 'completed')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (draftError) throw draftError
  if (!draft) return
  const { error } = await supabase.rpc('activate_rookie_draft_league_atomic', { p_draft_id: draft.id })
  if (error) throw error
}
