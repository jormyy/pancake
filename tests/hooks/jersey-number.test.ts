import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useJerseyNumber } from '@/hooks/use-jersey-number'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const queries = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ in: queries.read }) }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
function Jersey({ id, nbaId, jersey }: { id?: string; nbaId?: string; jersey?: string | null }) {
    return React.createElement('jersey', { value: useJerseyNumber(id, nbaId, jersey) })
}
const values = () => screen.root.findAllByType('jersey' as React.ElementType).map(node => node.props.value)
beforeEach(() => {
    setSessionOwner('jersey-test')
    clearSessionCaches()
    queries.read.mockReset().mockImplementation(async (_column: string, ids: string[]) => ({ data: ids.map(id => ({ id, nba_id: id, jersey_number: '15' })), error: null }))
})
afterEach(async () => {
    await act(async () => screen?.unmount())
    clearSessionCaches()
    setSessionOwner(null)
})
it('shows supplied jersey numbers without another read', async () => {
    await act(async () => { screen = create(React.createElement(React.Fragment, null,
        React.createElement(Jersey, { id: 'one', jersey: '3' }),
        React.createElement(Jersey, { id: 'two', jersey: null }),
    )) })
    expect(values()).toEqual(['3', null])
    expect(queries.read).not.toHaveBeenCalled()
})
it('fills missing jersey numbers in deduplicated batches of at most 100 players', async () => {
    await act(async () => {
        screen = create(React.createElement(React.Fragment, null, ...Array.from({ length: 206 }, (_, i) => React.createElement(Jersey, { key: i, id: `player-${i % 205}` }))))
    })
    expect(queries.read.mock.calls.map(call => call[1].length)).toEqual([100, 100, 5])
    expect(values().every(value => value === '15')).toBe(true)
    await act(async () => { screen.update(React.createElement(Jersey, { id: 'player-0' })) })
    expect(queries.read).toHaveBeenCalledTimes(3)
})
it('finds a player from the NBA identity when no player ID is supplied', async () => {
    await act(async () => { screen = create(React.createElement(Jersey, { nbaId: '1631234' })) })
    expect(queries.read).toHaveBeenCalledWith('nba_id', ['1631234'])
    expect(values()).toEqual(['15'])
})
it('rejects a response from the previous signed-in account', async () => {
    let finish!: (value: unknown) => void
    queries.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await act(async () => { screen = create(React.createElement(Jersey, { id: 'old' })) })
    setSessionOwner('new-account')
    await act(async () => {
        finish({ data: [{ id: 'old', jersey_number: '15' }], error: null })
        screen.update(React.createElement(Jersey, { jersey: null }))
    })
    expect(values()).toEqual([null])
})
it('keeps unknown numbers absent and retries a failed lookup on remount', async () => {
    queries.read.mockResolvedValueOnce({ data: null, error: new Error('Offline') })
    await act(async () => { screen = create(React.createElement(Jersey, { id: 'retry' })) })
    expect(values()).toEqual([null])
    await act(async () => screen.unmount())
    await act(async () => { screen = create(React.createElement(Jersey, { id: 'retry' })) })
    expect(values()).toEqual(['15'])
})
