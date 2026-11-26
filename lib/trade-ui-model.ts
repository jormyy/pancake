import type { RosterPlayer } from '@/lib/roster'
import type { TradePickItem } from '@/lib/trades'

export type TradeTabKey = 'offers' | 'block' | 'history'

export const TRADE_TABS: readonly { label: string; value: TradeTabKey }[] = [
    { label: 'Offers', value: 'offers' },
    { label: 'Block', value: 'block' },
    { label: 'History', value: 'history' },
]

export function normalizeTradeTab(value: unknown): TradeTabKey {
    const tab = Array.isArray(value) ? value[0] : value
    if (tab === 'history') return 'history'
    if (tab === 'block' || tab === 'my-block' || tab === 'league-block' || tab === 'leagueBlock') return 'block'
    return 'offers'
}

export type TradeComposerMember = {
    id: string
    team_name: string | null
}

export type TradeParticipantView = {
    memberId: string
    destinationIds: string[]
    defaultDestinationId: string
    roster: RosterPlayer[]
    picks: TradePickItem[]
    selectedPlayerIds: Set<string>
    selectedPickIds: Set<string>
    playerDestinationIds: Record<string, string>
    pickDestinationIds: Record<string, string>
    faabInputs: Record<string, string>
}
