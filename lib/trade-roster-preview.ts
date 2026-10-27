import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeRosterPlan, TradeRosterPreview } from '@/lib/trades'

export function previewTradeRosters(
    members: { memberId: string; teamName: string }[],
    rosters: Record<string, RosterPlayer[]>,
    items: { kind: string; playerId?: string; fromMemberId: string; toMemberId: string; toTaxi?: boolean; toIR?: boolean }[],
    plans: Record<string, TradeRosterPlan>,
    limits: TradeRosterPreview['limits'],
): TradeRosterPreview[] {
    return members.map(({ memberId, teamName }) => {
        const plan = plans[memberId] ?? { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }
        const retained = (rosters[memberId] ?? []).filter((row) => !plan.dropPlayerIds.includes(row.players.id)
            && !items.some((item) => item.kind === 'player' && item.fromMemberId === memberId && item.playerId === row.players.id))
        const incoming = items.flatMap((item) => {
            if (item.kind !== 'player' || item.toMemberId !== memberId) return []
            const row = rosters[item.fromMemberId]?.find((player) => player.players.id === item.playerId)
            return row ? [{ row, item }] : []
        })
        const roster: TradeRosterPreview['roster'] = retained.map((row) => ({
            playerId: row.players.id,
            name: row.players.display_name,
            location: plan.rosterMoves?.find((move) => move.playerId === row.players.id)?.destination
                ?? (row.is_on_taxi ? 'taxi' : row.is_on_ir ? 'ir' : 'active'),
        }))
        roster.push(...incoming.map(({ row, item }) => ({
            playerId: row.players.id,
            name: row.players.display_name,
            location: row.is_on_taxi || plan.taxiPlayerIds.includes(row.players.id) || item.toTaxi ? 'taxi' as const
                : plan.irPlayerIds.includes(row.players.id) || item.toIR ? 'ir' as const : 'active' as const,
        })))
        const overflow = (['active', 'ir', 'taxi'] as const).find((location) => roster.filter((row) => row.location === location).length > limits[location])
        const invalidIR = roster.find((row) => row.location === 'ir' && !isIREligible(
            Object.values(rosters).flat().find((player) => player.players.id === row.playerId)?.players.injury_status ?? null,
        ))
        return {
            memberId, teamName, roster, limits,
            drops: (rosters[memberId] ?? []).filter((row) => plan.dropPlayerIds.includes(row.players.id)).map((row) => ({ playerId: row.players.id, name: row.players.display_name })),
            moves: plan.rosterMoves ?? [],
            error: overflow ? `This team needs a plan for its ${overflow === 'active' ? 'regular' : overflow.toUpperCase()} roster limit.`
                : invalidIR ? `${invalidIR.name} cannot remain on IR.` : null,
        }
    })
}
