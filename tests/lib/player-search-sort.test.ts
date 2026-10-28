import { describe, expect, it, vi } from 'vitest'
import { STAT_COLUMN_SORT, PLAYER_SEARCH_SORT_OPTIONS, readPlayerSort, savePlayerSort, compareDynastyPlayers } from '@/lib/player-search-sort'

describe('sort column maps', () => {
    it('maps each desktop table header label to a sort mode', () => {
        expect(STAT_COLUMN_SORT['3PM']).toBe('tpm')
        expect(STAT_COLUMN_SORT.FP).toBe('fpts')
        expect(STAT_COLUMN_SORT.MIN).toBe('min')
        expect(STAT_COLUMN_SORT.GP).toBe('gp')
    })
})

it('offers and restores the device dynasty sort without an expiry', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) })
    expect(PLAYER_SEARCH_SORT_OPTIONS).toContainEqual({ key: 'dynasty', label: 'Dynasty rank' })
    savePlayerSort({ mode: 'dynasty', dir: 'asc' })
    expect(readPlayerSort()).toEqual({ mode: 'dynasty', dir: 'asc' })
    vi.unstubAllGlobals()
})

it('orders mixed ranks before season averages and keeps ties deterministic', () => {
    const rows = [
        { id: '6', display_name: 'No average', dynasty_rank: null },
        { id: '4', display_name: 'Tie', avg_fantasy_points: 40 },
        { id: '2', display_name: 'Second', dynasty_rank: 2, avg_fantasy_points: 100 },
        { id: '5', display_name: 'Negative', dynasty_rank: null, avg_fantasy_points: -2 },
        { id: '3', display_name: 'Tie', dynasty_rank: null, avg_fantasy_points: 40 },
        { id: '1', display_name: 'First', dynasty_rank: 1, avg_fantasy_points: 0 },
    ]
    expect([...rows].sort(compareDynastyPlayers).map(row => row.id)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect([...rows].reverse().sort(compareDynastyPlayers).map(row => row.id)).toEqual(['1', '2', '3', '4', '5', '6'])
})
