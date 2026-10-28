import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPreview } from '@/lib/trades'

export function isTradeRosterLegal(team: TradeRosterPreview | undefined) {
    return Boolean(team && !team.error && (['active', 'ir', 'taxi'] as const).every(location =>
        team.roster.filter(player => player.location === location).length <= team.limits[location]))
}

export function tradeLegalityStep(team: TradeRosterPreview, roster: RosterPlayer[], incoming: TradeItem[]) {
    const count = (location: 'active' | 'ir' | 'taxi') => team.roster.filter(player => player.location === location).length
    const overflow = (['active', 'ir', 'taxi'] as const).reduce((total, location) => total + Math.max(0, count(location) - team.limits[location]), 0)
    if (!overflow) return isTradeRosterLegal(team) ? 'Roster ready' : 'Update roster choices to continue'
    const players = `${overflow} ${overflow === 1 ? 'player' : 'players'}`
    const incomingPlayers = incoming.filter(item => item.kind === 'player')
    const eligibleIR = team.roster.filter(player => player.location === 'active' && !team.unavailableMoves?.[player.playerId] && !team.unavailableDestinations?.[player.playerId]?.ir && (
        isIREligible(roster.find(row => row.players.id === player.playerId)?.players.injury_status ??
            incomingPlayers.find(item => item.playerId === player.playerId && !item.fromTaxi)?.injuryStatus ?? null)
    )).length
    if (count('active') - team.limits.active === overflow && team.limits.ir - count('ir') >= overflow && eligibleIR >= overflow) {
        return `Move ${players} to IR or drop ${overflow}`
    }
    if (count('taxi') - team.limits.taxi === overflow && team.limits.active - count('active') >= overflow &&
        team.roster.filter(player => player.location === 'taxi' && roster.some(row => row.players.id === player.playerId)).length >= overflow) {
        return `Move ${players} to Regular or drop ${overflow}`
    }
    if (count('ir') - team.limits.ir === overflow && team.limits.active - count('active') >= overflow) {
        return `Move ${players} to Regular or drop ${overflow}`
    }
    return `Drop ${players} to continue`
}
