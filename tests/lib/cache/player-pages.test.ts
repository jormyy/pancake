import { expect, it } from 'vitest'
import { mergePlayerPage, playerPageOffset, type PlayerPages } from '@/lib/cache/player-pages'
import { playerRow } from '../../helpers/fixtures'

const searchPayload = (ids: string[], hasMore = false) => ({ players: ids.map(id => playerRow({ id })), visibleTotals: [], hasMore } as PlayerPages)

it('tracks consumed offsets separately from deduplicated row counts', () => {
    const first = searchPayload(['a', 'b'], true)
    const next = searchPayload(['b', 'c'], true)
    const merged = mergePlayerPage(first, next, 2)
    expect(merged.players.map(player => player.id)).toEqual(['a', 'b', 'c'])
    expect(playerPageOffset(merged)).toBe(4)
    expect(merged.hasMore).toBe(true)
})
it('replaces overlapping rows in place and retains the loaded tail', () => {
    const first = searchPayload(['a', 'b', 'c', 'd'], true)
    const next = searchPayload(['a', 'b'], true)
    next.players[0].avg_points = 99
    const merged = mergePlayerPage(first, next, 0)
    expect(merged.players.map(player => player.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.players[0].avg_points).toBe(99)
    expect(playerPageOffset(merged)).toBe(4)
})
it('clears omitted live totals for refreshed rows and retains totals on other pages', () => {
    const first = { ...searchPayload(['a', 'b'], true), visibleTotals: [
        { player_id: 'a', totals: { points: 10 }, rounded_fantasy_average: null, game_status: 'Final', game_time: null, started_at: null },
        { player_id: 'b', totals: { points: 20 }, rounded_fantasy_average: null, game_status: 'Final', game_time: null, started_at: null },
    ] }
    const merged = mergePlayerPage(first, searchPayload(['a'], true), 0)
    expect(merged.visibleTotals.map(row => row.player_id)).toEqual(['b'])
})
it('preserves the last page marker through an earlier-page replacement', () => {
    const first = { ...searchPayload(['a', 'b', 'c']), nextOffset: 3 }
    const merged = mergePlayerPage(first, searchPayload(['a'], true), 0)
    expect(merged.hasMore).toBe(false)
    expect(playerPageOffset(merged)).toBe(3)
})

it('uses refreshed values when a row moves into an earlier page', () => {
    const first = searchPayload(['a', 'b', 'c', 'd'], true)
    const next = searchPayload(['c', 'a'], true)
    next.players[0].avg_points = 99
    const merged = mergePlayerPage(first, next, 0)
    expect(merged.players.map(player => player.id)).toEqual(['c', 'a', 'd'])
    expect(merged.players[0].avg_points).toBe(99)
    expect(playerPageOffset(merged)).toBe(4)
})
