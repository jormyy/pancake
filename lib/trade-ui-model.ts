import type { RosterPlayer } from '@/lib/roster'
import type { TradePickItem } from '@/lib/trades'

export type TradeTabKey = 'picks' | 'offers' | 'analyzer' | 'history' | 'block' | 'leagueBlock'

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
