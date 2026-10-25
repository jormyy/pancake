import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NoLeagueState } from '@/components/NoLeagueState'

const state = vi.hoisted(() => ({ membershipStatus: 'loading', online: true, loading: true, refresh: vi.fn(), push: vi.fn() }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => state }))
vi.mock('@/components/ui', () => ({ Button: 'Button', LoadingState: 'LoadingState' }))
vi.mock('@/components/ui/PromptFrame', () => ({ PromptFrame: 'PromptFrame' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks()
    state.membershipStatus = 'loading'
    state.loading = true
    state.online = true
})
afterEach(async () => { await act(async () => screen?.unmount()) })
const mount = async () => { await act(async () => { screen = create(React.createElement(NoLeagueState)) }) }

it.each(['loading', 'available'])('keeps %s league access neutral', async membershipStatus => {
    state.membershipStatus = membershipStatus
    await mount()
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByType('Button' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'League access is unavailable' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'Welcome to Pancake' })).toHaveLength(0)
})

it('shows a retry only after league access fails', async () => {
    await mount()
    expect(screen.root.findAllByType('Button' as React.ElementType)).toHaveLength(0)
    state.membershipStatus = 'unavailable'
    state.loading = false
    await act(async () => screen.update(React.createElement(NoLeagueState)))
    expect(screen.root.findAllByProps({ children: 'League access is unavailable' })).toHaveLength(1)
    const button = screen.root.findByProps({ title: 'Retry league access' })
    expect(button.props.disabled).toBe(false)
    await act(async () => button.props.onPress())
    expect(state.refresh).toHaveBeenCalledOnce()
})

it('offers league creation only after a confirmed empty membership read', async () => {
    state.membershipStatus = 'empty'
    state.loading = false
    await mount()
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'Welcome to Pancake' })).toHaveLength(1)
    await act(async () => screen.root.findByProps({ title: 'Create a League' }).props.onPress())
    expect(state.push).toHaveBeenCalledWith('/(modals)/create-league')
})

it('renders no league prompt after sign-out', async () => {
    state.membershipStatus = 'signed-out'
    state.loading = false
    await mount()
    expect(screen.toJSON()).toBeNull()
})
