import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LeagueAccessNotice } from '@/components/LeagueAccessNotice'

const state = vi.hoisted(() => ({ memberships: [{}], membershipError: null as string | null, online: true, refresh: vi.fn() }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => state }))
vi.mock('@/components/ui', () => ({ ErrorBanner: 'ErrorBanner' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const render = async () => { await act(async () => { screen = create(React.createElement(LeagueAccessNotice)) }) }
beforeEach(() => { state.memberships = [{}]; state.membershipError = null; state.online = true; state.refresh.mockReset() })
afterEach(async () => { await act(async () => screen?.unmount()) })

it('announces offline access without entering document flow', async () => {
    state.online = false
    await render()
    const notice = screen.root.findByProps({ role: 'status' })
    expect(notice.props['aria-live']).toBe('polite')
    expect(Object.assign({}, ...notice.props.style).position).toBe('fixed')
    expect(screen.root.findByType('Text' as React.ElementType).props.children).toBe('Offline · showing saved data')
    state.online = true
    await act(async () => screen.update(React.createElement(LeagueAccessNotice)))
    expect(screen.toJSON()).toBeNull()
})

it('keeps the access error visible and retryable in the same overlay', async () => {
    state.membershipError = 'unavailable'
    await render()
    expect(Object.assign({}, ...screen.root.findByProps({ role: 'status' }).props.style).position).toBe('fixed')
    const banner = screen.root.findByType('ErrorBanner' as React.ElementType)
    expect(banner.props.message).toBe('League access could not be checked. Tap to retry.')
    await act(async () => banner.props.onRetry())
    expect(state.refresh).toHaveBeenCalledOnce()
})

it('does not announce league access when there is no membership', async () => {
    state.memberships = []
    state.online = false
    await render()
    expect(screen.toJSON()).toBeNull()
})
