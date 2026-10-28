import { pickLabel } from '@/lib/picks'
import type { Trade, TradeRosterPreview } from '@/lib/trades'

export function tradeCapacityLine(team: TradeRosterPreview) {
    const count = (location: string) => team.roster.filter(player => player.location === location).length
    return `${team.teamName}: ${count('active')}/${team.limits.active} · IR ${count('ir')}/${team.limits.ir} · Taxi ${count('taxi')}/${team.limits.taxi}`
}

export function tradeAcceptanceSummary(trade: Trade, teams: TradeRosterPreview[], memberId: string) {
    const assets = (direction: 'fromMemberId' | 'toMemberId') => trade.routedItems.filter(item => item[direction] === memberId)
        .map(item => item.kind === 'player' ? item.playerName : item.kind === 'pick' ? `${pickLabel(item.seasonYear, item.round)} pick` : `$${item.amount} FAAB`).join(', ') || 'nothing'
    const drops = teams.find(team => team.memberId === memberId)?.drops ?? []
    return [`You give: ${assets('fromMemberId')}`, `You get: ${assets('toMemberId')}`, ...teams.map(tradeCapacityLine),
        ...(drops.length ? [`Drops: ${drops.map(player => player.name).join(', ')}`] : []), 'Completes after review.'].join('\n')
}
