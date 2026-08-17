import { describe, expect, it } from 'vitest'
import { saveTradeAnalyzerDraft, takeTradeAnalyzerDraft } from '@/lib/trade-analyzer-session'
import { buildMultiTeamTradeItems, multiTeamTradeStateFromItems } from '@/lib/multi-team-trade-state'

describe('trade analyzer handoff', () => {
    const items = [
        { kind: 'player' as const, fromMemberId: 'me', toMemberId: 'them', playerId: 'p1' },
        { kind: 'pick' as const, fromMemberId: 'them', toMemberId: 'me', pickId: 'pick1' },
        { kind: 'faab' as const, fromMemberId: 'me', toMemberId: 'them', faabAmount: 12 },
    ]

    it('keeps routed players, picks, and FAAB when the offer editor opens', () => {
        const state = multiTeamTradeStateFromItems('me', ['me', 'them'], items)
        expect(buildMultiTeamTradeItems(state, true)).toEqual(expect.arrayContaining(items))
    })

    it('uses one-time session memory for private experiments', () => {
        const draft = {
            leagueId: 'league',
            actorMemberId: 'me',
            participantMemberIds: ['me', 'them'],
            items,
        }
        const id = saveTradeAnalyzerDraft(draft)
        expect(takeTradeAnalyzerDraft(id)).toEqual(draft)
        expect(takeTradeAnalyzerDraft(id)).toBeNull()
    })
})
