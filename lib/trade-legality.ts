import { apiPost } from '@/lib/shared/api'
import type { MultiTeamTradeItemPayload, TradeRosterPlan, TradeRosterPreview } from '@/lib/trades'

export type TradeLegalityReason = {
    memberId: string
    teamName: string
    rule: string
    message: string
    playerId?: string
    count?: number
    suggestedMoves: {
        action: string
        message: string
        playerId?: string
        playerName?: string
        destination?: 'active' | 'ir' | 'taxi'
        count?: number
    }[]
}

export async function previewTradeLegality(input: {
    leagueId: string
    memberIds?: string[]
    items?: MultiTeamTradeItemPayload[]
    plans?: Record<string, TradeRosterPlan>
    tradeId?: string
}): Promise<TradeRosterPreview[]> {
    const result = await apiPost<{ teams: TradeRosterPreview[] }>('/trades/legality', input)
    return result.teams
}
