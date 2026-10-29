import type { MultiTeamTradeItemPayload, RoutedTradeItem, Trade } from '@/lib/trades'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

export function tradeDraft({ items, participants, memberId, participantName, notes, expiresAt, avgMap, avgStatsMap }: {
    items: MultiTeamTradeItemPayload[]
    participants: TradeParticipantView[]
    memberId: string
    participantName: (id: string) => string
    notes: string
    expiresAt: string | null
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
}): Trade {
    const routedItems = items.flatMap((item): RoutedTradeItem[] => {
        if (item.kind === 'faab') return [{ ...item, amount: item.faabAmount }]
        if (item.kind === 'pick') {
            const pick = participants.flatMap(team => team.picks).find(pick => pick.pickId === item.pickId)
            return pick ? [{ ...pick, ...item }] : []
        }
        const row = participants.flatMap(team => team.roster).find(row => row.players.id === item.playerId)
        if (!row) return []
        const player = row.players
        return [{ ...item, playerName: player.display_name, position: player.position, eligiblePositions: player.eligible_positions,
            nbaTeam: player.nba_team, nbaId: player.nba_id, injuryStatus: player.injury_status, yearsExp: player.years_exp,
            careerGames: player.career_regular_season_games, fromTaxi: row.is_on_taxi,
            avgFantasyPoints: avgMap.get(player.id), avgMinutesPlayed: avgStatsMap.get(player.id)?.avg_minutes_played }]
    })
    const recipient = participants.find(team => team.memberId !== memberId)?.memberId ?? ''
    return {
        id: 'draft', status: 'pending', proposedAt: '', acceptedAt: null, vetoWindowExpiresAt: null,
        completedAt: null, vetoedAt: null, expiresAt, notes,
        proposerMemberId: memberId, proposerTeamName: participantName(memberId),
        recipientMemberId: recipient, recipientTeamName: participantName(recipient),
        isMultiTeam: participants.length > 2,
        participants: participants.map((team, index) => ({ memberId: team.memberId, teamName: participantName(team.memberId),
            sortOrder: index, isInitiator: team.memberId === memberId, acceptedAt: null })),
        parentTradeId: null, counteredFromTradeId: null, editedFromTradeId: null, replacedByTradeId: null,
        version: 1, proposerFaabAmount: 0, recipientFaabAmount: 0, myVetoed: false, routedItems,
    }
}
