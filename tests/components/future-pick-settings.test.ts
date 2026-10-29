import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FuturePickYearsSetting } from '@/components/commissioner/FuturePickYearsSetting'

const state = vi.hoisted(() => ({ years: 5, failure: null as Error | null, update: vi.fn() }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'official' } }) }))
vi.mock('@/components/ui', () => ({ Button: 'Button', ErrorBanner: 'ErrorBanner' }))
vi.mock('@/lib/league', () => ({
    getLeagueFuturePickYears: async () => state.years,
    updateLeagueConfiguration: (...args: unknown[]) => { state.update(...args); return state.failure ? Promise.reject(state.failure) : Promise.resolve() },
}))
let screen: ReactTestRenderer
beforeEach(() => { state.years = 5; state.failure = null; state.update.mockClear() })
afterEach(async () => { await act(async () => screen?.unmount()) })
const input = () => screen.root.findByType('TextInput' as React.ElementType)
const button = () => screen.root.findByType('Button' as React.ElementType)
const render = async (disabled = false) => { await act(async () => { screen = create(React.createElement(FuturePickYearsSetting, { disabled })) }) }

it('loads the official league setting and saves a commissioner change', async () => {
    await render()
    expect(input().props.value).toBe('5')
    expect(button().props.disabled).toBe(true)
    await act(async () => input().props.onChangeText('10'))
    await act(async () => button().props.onPress())
    expect(state.update).toHaveBeenCalledWith('official', { future_pick_years: 10 }, null)
    expect(button().props.disabled).toBe(true)
})

it.each(['0', '11', '1.5', ''])('rejects invalid future years: %s', async value => {
    await render()
    await act(async () => input().props.onChangeText(value))
    await act(async () => button().props.onPress())
    expect(state.update).not.toHaveBeenCalled()
    expect(screen.root.findByType('ErrorBanner' as React.ElementType).props.message).toContain('between 1 and 10')
})

it('shows the server’s traded-pick protection message and preserves the saved value', async () => {
    state.failure = new Error('Future draft years cannot be lower than 5 because a pick in that year has been traded or included in a trade.')
    await render()
    await act(async () => input().props.onChangeText('4'))
    await act(async () => button().props.onPress())
    expect(screen.root.findByType('ErrorBanner' as React.ElementType).props.message).toBe(state.failure.message)
    expect(button().props.disabled).toBe(false)
})

it('disables changes without commissioner authority', async () => {
    await render(true)
    expect(input().props.editable).toBe(false)
    expect(button().props.disabled).toBe(true)
})
