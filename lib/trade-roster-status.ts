import type { TradeLegalityReason } from '@/lib/trade-legality'
import type { TradeRosterPreview } from '@/lib/trades'

export function tradeRosterReasons(team: TradeRosterPreview): string[] {
    return [...new Set((team.reasons ?? []).map(reason => shortReason(team, reason)))]
}

function shortReason(team: TradeRosterPreview, reason: TradeLegalityReason): string {
    const count = (location: 'active' | 'ir' | 'taxi') => team.roster.filter(row => row.location === location).length
    const player = team.roster.find(row => row.playerId === reason.playerId)?.name
        ?? reason.suggestedMoves.find(move => move.playerName)?.playerName
        ?? 'Player'
    switch (reason.rule) {
        case 'roster_size': {
            const limit = team.limits.active + team.limits.ir + team.limits.taxi
            return `${team.roster.length - limit} over total limit (${team.roster.length}/${limit})`
        }
        case 'active_slots': return `${count('active') - team.limits.active} over roster limit (${count('active')}/${team.limits.active})`
        case 'ir_limit': return `IR full (${count('ir')}/${team.limits.ir})`
        case 'taxi_limit': return `Taxi full (${count('taxi')}/${team.limits.taxi})`
        case 'ir_eligibility': return `${player} isn't IR-eligible`
        case 'taxi_eligibility': return `${player} isn't Taxi-eligible`
        case 'ir_trade_eligibility': return 'Move outgoing IR players to Regular first'
        case 'taxi_trade_eligibility': return 'Move outgoing Taxi players to Regular first'
        case 'ownership': return 'Remove players no longer on the offering roster'
        case 'planned_move': return 'Remove moves for unavailable players'
        case 'destination_slot': return 'Choose one slot for each incoming player'
        case 'budget': return 'Not enough FAAB for this trade'
        default: return reason.message.replace(`${team.teamName}: `, '').split('. ')[0]
    }
}
