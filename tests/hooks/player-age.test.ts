import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePlayerAge } from '@/hooks/use-player-age'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const queries = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ in: queries.read }) }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
function Age({ id, birthdate, age, nbaId }: { id?: string; birthdate?: string | null; age?: number; nbaId?: string }) {
    return React.createElement('age', { value: usePlayerAge(id, birthdate, age, nbaId) })
}
beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
    setSessionOwner('age-test')
    clearSessionCaches()
    queries.read.mockReset().mockImplementation(async (_column: string, ids: string[]) => ({ data: ids.map(id => ({ id, nba_id: id, birthdate: '2001-10-29' })), error: null }))
})
afterEach(async () => {
    await act(async () => screen?.unmount())
    clearSessionCaches()
    setSessionOwner(null)
    vi.useRealTimers()
})
it('shows supplied ages and birthdays without another read', async () => {
    await act(async () => { screen = create(React.createElement(React.Fragment, null,
        React.createElement(Age, { id: 'one', birthdate: '2001-10-29' }),
        React.createElement(Age, { id: 'two', age: 25.4 }),
        React.createElement(Age, { id: 'three', birthdate: null }),
    )) })
    expect(screen.root.findAllByType('age' as React.ElementType).map(node => node.props.value)).toEqual([24, 25.4, null])
    expect(queries.read).not.toHaveBeenCalled()
})
it('fills missing ages in deduplicated batches of at most 100 players', async () => {
    await act(async () => {
        screen = create(React.createElement(React.Fragment, null, ...Array.from({ length: 206 }, (_, i) => React.createElement(Age, { key: i, id: `player-${i % 205}` }))))
    })
    expect(queries.read.mock.calls.map(call => call[1].length)).toEqual([100, 100, 5])
    expect(screen.root.findAllByType('age' as React.ElementType).every(node => node.props.value === 24)).toBe(true)
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    await act(async () => { screen.update(React.createElement(Age, { id: 'player-0' })) })
    expect(screen.root.findByType('age' as React.ElementType).props.value).toBe(25)
    expect(queries.read).toHaveBeenCalledTimes(3)
})
it('finds a news player from the NBA identity when no player ID is supplied', async () => {
    await act(async () => { screen = create(React.createElement(Age, { nbaId: '1631234' })) })
    expect(queries.read).toHaveBeenCalledWith('nba_id', ['1631234'])
    expect(screen.root.findByType('age' as React.ElementType).props.value).toBe(24)
})
it('rejects an age response from the previous signed-in account', async () => {
    let finish!: (value: unknown) => void
    queries.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Age, { id: 'old' })) })
    setSessionOwner('new-account')
    await act(async () => {
        finish({ data: [{ id: 'old', birthdate: '2001-10-29' }], error: null })
        screen.update(React.createElement(Age, { birthdate: null }))
    })
    expect(screen.root.findByType('age' as React.ElementType).props.value).toBeNull()
})
it('keeps unknown ages absent and retries a failed lookup on remount', async () => {
    queries.read.mockResolvedValueOnce({ data: null, error: new Error('Offline') })
    await act(async () => { screen = create(React.createElement(Age, { id: 'retry' })) })
    expect(screen.root.findByType('age' as React.ElementType).props.value).toBeNull()
    await act(async () => screen.unmount())
    await act(async () => { screen = create(React.createElement(Age, { id: 'retry' })) })
    expect(screen.root.findByType('age' as React.ElementType).props.value).toBe(24)
})
