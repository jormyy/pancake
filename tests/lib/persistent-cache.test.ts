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

    it('expires entries by saved age', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-09T00:00:00Z'))
        writePersistentCache('pancake:test:old', { value: 1 })

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1)

        expect(readPersistentCache('pancake:test:old')).toBeNull()
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
})
