import { describe, expect, it, vi } from 'vitest'
import { leagueChangeReceiver } from '@/lib/league-changes'

const season = '10000000-0000-4000-8000-000000000001'
const detail = { resource: 'claims', season_id: season }
const row = (revision: number | string, details: unknown = [detail], topic = 'inventory') => ({ league_id: 'league', topic, revision, scopes: null, details })

describe('bounded resource hints', () => {
    it('requires a baseline and contiguous revision before accepting narrow details', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row('9007199254740993'))
        consume(row('9007199254740994'))
        consume(row('9007199254740996'))
        consume(row('9007199254740996'))
        expect(receive.mock.calls.map(([change]) => change.details)).toEqual([null, [detail], null])
    })

    it.each([
        undefined,
        [],
        [{ ...detail, member_id: '20000000-0000-4000-8000-000000000001' }],
        [{ ...detail, player_id: 'private' }],
        [{ ...detail, resource: 'future-resource' }],
        [{ ...detail, season_id: 'not-a-uuid' }],
        Array.from({ length: 17 }, (_, index) => ({ resource: 'picks', season_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` })),
    ])('broadens an invalid or unknown detail instead of dropping the change: %j', details => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(1))
        consume({ ...row(2), details })
        expect(receive.mock.calls.at(-1)?.[0].details).toBeNull()
        expect(receive).toHaveBeenCalledTimes(2)
    })

    it('takes a broad catch-up for unsafe counters and unknown topics', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(1))
        consume(row(Number.MAX_SAFE_INTEGER + 1))
        consume(row(2))
        consume(row(3, [detail], 'new-topic'))
        expect(receive.mock.calls.map(([change]) => [change.topic, change.details ?? null])).toEqual([
            ['inventory', null], ['inventory', null], ['inventory', null], ['catchup', null],
        ])
    })

    it('accepts daily sources separately from inventory and preserves future pick seasons', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(1, null, 'resources'))
        consume(row(2, [{ resource: 'averages', season_id: season }], 'resources'))
        consume(row(1))
        consume(row(2, [{ resource: 'picks', season_id: '10000000-0000-4000-8000-000000000099', member_id: '20000000-0000-4000-8000-000000000001' }]))
        expect(receive.mock.calls.at(-1)?.[0].details?.[0].season_id).toMatch(/099$/)
        expect(receive.mock.calls[1][0]).toMatchObject({ topic: 'resources', details: [{ resource: 'averages', season_id: season }] })
    })
})
