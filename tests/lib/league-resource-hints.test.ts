import { describe, expect, it, vi } from 'vitest'
import { leagueChangeReceiver, leagueResourceAffects, leagueSnapshotRevision, notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'

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
        [{ ...detail, season_id: 'not-a-uuid' }],
        Array.from({ length: 17 }, (_, index) => ({ resource: 'picks', season_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` })),
    ])('broadens an invalid detail instead of dropping the change: %j', details => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(1))
        consume({ ...row(2), details })
        expect(receive.mock.calls.at(-1)?.[0].details).toBeNull()
        expect(receive).toHaveBeenCalledTimes(2)
    })

    it('takes a broad catch-up for unsafe counters', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(1))
        consume(row(Number.MAX_SAFE_INTEGER + 1))
        consume(row(2))
        consume(row(3, [detail], 'new-topic'))
        expect(receive.mock.calls.map(([change]) => [change.topic, change.details ?? null])).toEqual([
            ['inventory', null], ['inventory', null], ['inventory', null],
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

it('broadens a missing inventory scope field and requires a new trusted cursor', () => {
    const receive = vi.fn()
    const consume = leagueChangeReceiver('league', receive)
    consume(row(1))
    consume({ ...row(2), scopes: undefined })
    consume(row(3))
    expect(receive.mock.calls.map(([change]) => change.details)).toEqual([null, null, null])
})


it('keeps broad invalidation inside its topic and includes future-season picks for their owner', () => {
    expect(leagueResourceAffects({ topic: 'resources', scopes: null, details: null }, ['season'])).toBe(false)
    expect(leagueResourceAffects({ topic: 'resources', scopes: null, details: null }, ['averages'])).toBe(true)
    expect(leagueResourceAffects({ topic: 'inventory', scopes: null, details: null }, ['averages'])).toBe(false)
    const futurePick = { topic: 'inventory' as const, scopes: null, details: [{ resource: 'picks' as const, season_id: 'future', member_id: 'mine' }] }
    expect(leagueResourceAffects(futurePick, ['picks'], { seasonId: season, memberId: 'mine' })).toBe(true)
    expect(leagueResourceAffects(futurePick, ['picks'], { seasonId: season, memberId: 'other' })).toBe(false)
})


it('keeps activity hints narrow and outside roster support resources', () => {
    const receive = vi.fn()
    const consume = leagueChangeReceiver('league', receive)
    const activity = { resource: 'activity' as const, season_id: season }
    consume(row(1))
    consume(row(2, [activity]))
    const change = receive.mock.calls.at(-1)![0]
    expect(change.details).toEqual([activity])
    expect(leagueResourceAffects(change, ['activity'])).toBe(true)
    expect(leagueResourceAffects(change, ['picks', 'claims', 'waivers', 'faab', 'priority', 'season'])).toBe(false)
})


it('keeps roster and pick cache revisions stable for activity-only inventory', () => {
    setLeagueChangesConnected('activity-cache', true)
    const domains = ['roster', 'support', 'picks'] as const
    const before = domains.map(domain => leagueSnapshotRevision('activity-cache', domain))
    notifyLeagueChange('activity-cache', { topic: 'inventory', scopes: null, details: [{ resource: 'activity', season_id: season }] })
    expect(domains.map(domain => leagueSnapshotRevision('activity-cache', domain))).toEqual(before)
    setLeagueChangesConnected('activity-cache', false)
})

it('ignores future topics and details without disconnecting or broad recovery', () => {
    const receive = vi.fn()
    const consume = leagueChangeReceiver('league', receive)
    expect(consume(row(1, null, 'future-topic'))).toBe(true)
    expect(consume(row(1, [{ resource: 'future-resource', season_id: season }]))).toBe(true)
    expect(receive).not.toHaveBeenCalled()
    consume(row(2, [detail, { resource: 'future-resource', season_id: season }]))
    expect(receive).toHaveBeenCalledExactlyOnceWith({ topic: 'inventory', scopes: null, details: [detail] })
})
