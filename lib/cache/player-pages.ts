import type { PlayersView } from '@/lib/cache/view-types'

export type PlayerPages = Pick<PlayersView, 'players' | 'visibleTotals' | 'hasMore'> & { nextOffset?: number }

export function playerPageOffset(view: PlayerPages): number {
    return view.nextOffset ?? view.players.length
}

export function mergePlayerPage(previous: PlayerPages, next: PlayerPages, offset: number): PlayerPages {
    const end = offset + playerPageOffset(next)
    const players = [...previous.players.slice(0, offset), ...next.players, ...previous.players.slice(end)]
    const unique = new Map(players.map(player => [player.id, player]))
    for (const player of next.players) unique.set(player.id, player)
    const totals = new Map(previous.visibleTotals.map(row => [row.player_id, row]))
    for (const player of next.players) totals.delete(player.id)
    for (const row of next.visibleTotals) totals.set(row.player_id, row)
    return {
        ...previous,
        ...next,
        players: [...unique.values()],
        visibleTotals: [...totals.values()].filter(row => unique.has(row.player_id)),
        nextOffset: Math.max(playerPageOffset(previous), end),
        hasMore: end >= playerPageOffset(previous) ? next.hasMore : previous.hasMore,
    }
}
