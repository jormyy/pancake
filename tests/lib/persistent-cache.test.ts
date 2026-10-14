import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

import {
    clearPersistentCaches,
    readPersistentCache,
    writePersistentCache,
} from '@/lib/persistent-cache'

describe('persistent cache bounds', () => {
    beforeEach(() => {
        clearPersistentCaches()
        vi.useRealTimers()
    })

    // Both sides of the boundary. Asserting only the expired side passes even
    // if the default age collapses to a millisecond and nothing is ever cached.
    it('keeps entries until a day old, then expires them', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-09T00:00:00Z'))
        const day = 24 * 60 * 60 * 1000
        writePersistentCache('pancake:test:entry', { value: 1 })

        vi.advanceTimersByTime(day - 1000)
        expect(readPersistentCache('pancake:test:entry')).toEqual({ value: 1 })

        vi.advanceTimersByTime(1001)
        expect(readPersistentCache('pancake:test:entry')).toBeNull()
    })

    it('bounds high-cardinality player-search entries', () => {
        for (let index = 0; index < 13; index += 1) {
            writePersistentCache(`pancake:player-search:${index}`, index)
        }

        expect(readPersistentCache('pancake:player-search:0')).toBeNull()
        expect(readPersistentCache('pancake:player-search:12')).toBe(12)
    })

    it('clears private app caches', () => {
        writePersistentCache('pancake:roster:user-a', ['private'])

        clearPersistentCaches()

        expect(readPersistentCache('pancake:roster:user-a')).toBeNull()
    })

    it('protects the in-memory startup choice and membership cache from age and pruning', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
        const selection = 'pancake:selected-league:v1:user-a'
        const memberships = 'pancake:league-memberships:v1:user-a'
        writePersistentCache(selection, 'member-a')
        writePersistentCache(memberships, ['member-a'])
        vi.setSystemTime(Date.now() + 7 * 86400_000)
        for (let index = 0; index < 80; index++) writePersistentCache(`pancake:test:${index}`, index)
        expect(readPersistentCache(selection)).toBe('member-a')
        expect(readPersistentCache(memberships)).toEqual(['member-a'])
        vi.setSystemTime(Date.now() + 365 * 86400_000)
        expect(readPersistentCache(selection)).toBe('member-a')
        expect(readPersistentCache(memberships)).toBeNull()
        clearPersistentCaches()
        expect(readPersistentCache(selection)).toBeNull()
    })
})
