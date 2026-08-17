import type { MultiTeamTradeItemPayload } from '@/lib/trades'

export type TradeAnalyzerDraft = {
    leagueId: string
    actorMemberId: string
    participantMemberIds: string[]
    items: MultiTeamTradeItemPayload[]
}

const drafts = new Map<string, TradeAnalyzerDraft>()

export function saveTradeAnalyzerDraft(draft: TradeAnalyzerDraft): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    drafts.set(id, draft)
    return id
}

export function takeTradeAnalyzerDraft(id: string): TradeAnalyzerDraft | null {
    const draft = drafts.get(id) ?? null
    drafts.delete(id)
    return draft
}
