import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useScreenView } from '@/hooks/use-screen-view'
import { clearScreenViews, saveScreenView, type ScreenScope } from '@/lib/cache/screen-cache'
const state = vi.hoisted(() => ({ online: false, focused: true, generation: 0, requests: vi.fn(), clears: [] as (() => void)[] }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => state.online }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => state.generation, sessionOwner: () => 'account', onSessionCachesCleared: (callback: () => void) => state.clears.push(callback) }))
vi.mock('@/lib/league-version', () => ({ subscribeLeagueVersion: () => () => {}, compareLeagueVersions: () => 0, leagueVersionSnapshot: () => ({ version: '1', changes: [] }), readLeagueVersion: async () => { state.requests(); return { version: '1', changes: [] } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const scope: ScreenScope = { accountId: 'account', leagueId: 'league', memberId: 'member', seasonId: 'season', screen: 'roster' }
beforeEach(() => { clearScreenViews(); state.online = false; state.focused = true; state.requests.mockClear(); vi.stubGlobal('navigator', { onLine: false }) })
it('renders the cached text on its first render while offline', async () => {
    saveScreenView(scope, { text: 'Accepted trade and awarded claim' }, '1')
    const renders: string[] = []
    let renderer!: ReactTestRenderer
    const Probe = () => { const view = useScreenView<{ text: string }>(scope); renders.push(`${view.data?.text}|${view.loading}|${view.offline}`); return React.createElement('span', null, view.data?.text) }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(renders[0]).toBe('Accepted trade and awarded claim|false|true'); expect(state.requests).not.toHaveBeenCalled()
    await act(async () => { renderer.unmount() })
})
it('never exposes the previous league during the first render after a switch', async () => {
    saveScreenView(scope, { text: 'Private first league' }, '1')
    const next = { ...scope, leagueId: 'other' }
    saveScreenView(next, { text: 'Second league' }, '1')
    const renders: string[] = []
    let renderer!: ReactTestRenderer
    const Probe = ({ selected }: { selected: ScreenScope }) => { const view = useScreenView<{ text: string }>(selected); renders.push(view.data?.text ?? 'empty'); return null }
    await act(async () => { renderer = create(React.createElement(Probe, { selected: scope })) })
    renders.length = 0
    await act(async () => { renderer.update(React.createElement(Probe, { selected: next })) })
    expect(renders).not.toContain('Private first league'); expect(renders[0]).toBe('Second league')
    await act(async () => { renderer.unmount() })
})
it('does no network work for an inactive screen', async () => {
    state.online = true; state.focused = false
    let renderer!: ReactTestRenderer
    const Probe = () => { useScreenView(scope); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(state.requests).not.toHaveBeenCalled()
    await act(async () => { renderer.unmount() })
})
