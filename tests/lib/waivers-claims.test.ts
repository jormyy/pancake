import { beforeEach, expect, it, vi } from 'vitest'
import { getMyWaiverClaims } from '@/lib/waivers'

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], errorStatus: null as string | null }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    from: (table: string) => {
        const filters: ((row: Record<string, unknown>) => boolean)[] = []
        const orders: { key: string; ascending: boolean }[] = []
        let limit = Infinity
        const query = {
            select: () => query,
            eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query },
            in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query },
            is: () => query,
            gt: () => query,
            order: (key: string, options: { ascending: boolean }) => { orders.push({ key, ...options }); return query },
            limit: (count: number) => { limit = count; return query },
            then: (resolve: (result: { data: Record<string, unknown>[]; error: Error | null }) => unknown) => {
                const rows = table === 'waiver_claims' ? state.rows.filter(row => filters.every(filter => filter(row))) : []
                rows.sort((a, b) => {
                    for (const order of orders) {
                        const left = a[order.key] as string | number
                        const right = b[order.key] as string | number
                        if (left !== right) return (left < right ? -1 : 1) * (order.ascending ? 1 : -1)
                    }
                    return 0
                })
                const error = rows.some(row => row.status === state.errorStatus) ? new Error('Claim read failed') : null
                return Promise.resolve(resolve({ data: rows.slice(0, limit), error }))
            },
        }
        return query
    },
} }))

const claim = (id: string, status: string, order: number, date: number) => ({
    id, status, claim_order: order, submitted_at: `2026-10-${String(date).padStart(2, '0')}`,
    member_id: 'member', league_season_id: 'season', player_id: id,
    claim_player: { display_name: id }, to_ir: false,
})

beforeEach(() => { state.rows = []; state.errorStatus = null })

it('keeps every pending claim before the twenty newest resolved claims', async () => {
    state.rows = [
        ...Array.from({ length: 25 }, (_, index) => claim(`resolved-${index + 1}`, index % 2 ? 'succeeded' : 'failed_priority', 1, index + 1)),
        claim('pending-second-later', 'pending', 2, 28),
        claim('pending-third', 'pending', 3, 29),
        claim('pending-first', 'pending', 1, 30),
        claim('pending-second-earlier', 'pending', 2, 27),
        claim('cancelled', 'cancelled', 1, 31),
        claim('other-member', 'pending', 1, 1),
        claim('other-season', 'pending', 1, 1),
    ]
    state.rows.at(-2)!.member_id = 'someone-else'
    state.rows.at(-1)!.league_season_id = 'previous-season'
    const result = await getMyWaiverClaims('member', 'league')
    expect(result.slice(0, 4).map(row => row.id)).toEqual([
        'pending-first', 'pending-second-earlier', 'pending-second-later', 'pending-third',
    ])
    expect(result.slice(4).map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => `resolved-${25 - index}`))
})

it.each(['pending', 'succeeded'])('reports a failed %s read', async status => {
    state.rows = [claim('claim', status, 1, 25)]
    state.errorStatus = status
    await expect(getMyWaiverClaims('member', 'league')).rejects.toThrow('Claim read failed')
})
