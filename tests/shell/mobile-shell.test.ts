import React from 'react'
import Module from 'node:module'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebAppShell } from '@/components/navigation/WebTabShell'

const state = vi.hoisted(() => {
    const current = { id: 'member-1', team_name: 'Team One', leagues: { id: 'league-1', name: 'Sunday Dynasty' } }
    return {
        pathname: '/', params: {} as { tradeId?: string }, current, memberships: [current], setCurrent: vi.fn(),
        draft: null as { id: string } | null, draftChecked: false, draftError: null as string | null,
        openDraftRoom: vi.fn(), push: vi.fn(),
    }
})

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, flatten: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({
    usePathname: () => state.pathname, useGlobalSearchParams: () => state.params, useRouter: () => ({ push: state.push }), Link: 'Link', Navigator: 'Navigator',
}))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ ...state, currentLeague: state.current.leagues, membershipStatus: 'ready', isCommissioner: false }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }))
vi.mock('@/hooks/use-pending-trade-count', () => ({ usePendingTradeCount: () => 0 }))
vi.mock('@/hooks/use-browser-read-activity', () => ({ useBrowserReadActivity: () => ({ active: false, revision: 0 }) }))
vi.mock('@/hooks/use-boot-shell-handoff', () => ({ useBootShellHandoff: vi.fn() }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({
    openDraftRoom: state.openDraftRoom, draftLoading: false, draft: state.draft,
    draftChecked: state.draftChecked, draftError: state.draftError,
}) }))
vi.mock('@/lib/auth', () => ({ getProfile: vi.fn(), suspendProfileRead: vi.fn() }))
vi.mock('@/lib/profile-updates', () => ({ listenForProfileUpdates: vi.fn() }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ visible, children, ...props }: React.PropsWithChildren<{ visible: boolean }>) => visible ? React.createElement('Sheet', props, children) : null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const render = async () => {
    await act(async () => { screen = create(React.createElement(WebAppShell, {}, React.createElement('Content'))) })
}
const controls = (label: string) => screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityLabel === label)

beforeEach(() => {
    state.pathname = '/'
    state.params = {}
    state.memberships = [state.current]
    state.draftChecked = false
    state.draft = null
    state.draftError = null
    vi.clearAllMocks()
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? 1 : originalLoad.call(moduleLoader, name, ...args))
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

it('shows a single league as a title and restores the switch when another league becomes available', async () => {
    await render()
    expect(controls('Switch league')).toHaveLength(0)
    expect(screen.root.findAll(node => node.type === ('Text' as React.ElementType) && node.props.children === 'Sunday Dynasty')).toHaveLength(1)
    state.memberships = [state.current, { ...state.current, id: 'member-2', leagues: { id: 'league-2', name: 'Second League' } }]
    await act(async () => screen.update(React.createElement(WebAppShell)))
    expect(controls('Switch league')).toHaveLength(1)
    expect(controls('Switch league')[0].props.onPress).toEqual(expect.any(Function))
})

it.each([
    '/player/123', '/lineup', '/propose-trade', '/claim-player', '/team-roster', '/change-password',
    '/commissioner-settings', '/create-league', '/join-league', '/bracket', '/draft', '/draft-room', '/rookie-draft-room', '/profile',
])('keeps bottom navigation while removing the duplicate header on %s', async pathname => {
    state.pathname = pathname
    await render()
    expect(controls('Open menu')).toHaveLength(0)
    expect(screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityRole === 'link')).toHaveLength(5)
    const main = screen.root.find(node => node.type === ('View' as React.ElementType) && node.props.role === 'main')
    const style = Object.assign({}, ...main.props.style.filter(Boolean))
    expect(style.paddingTop).toBe('env(safe-area-inset-top, 0px)')
})

it.each(['/', '/roster', '/players', '/trades', '/league'])('keeps the league header on %s', async pathname => {
    state.pathname = pathname
    await render()
    expect(controls('Open menu')).toHaveLength(1)
})

it('opens a trade with one header and restores the list header without remounting content', async () => {
    state.pathname = '/trades'
    state.params = { tradeId: 'incoming-trade' }
    await render()
    const content = screen.root.findByType('Content' as React.ElementType)
    expect(controls('Open menu')).toHaveLength(0)
    state.params = {}
    await act(async () => screen.update(React.createElement(WebAppShell, {}, React.createElement('Content'))))
    expect(controls('Open menu')).toHaveLength(1)
    expect(screen.root.findByType('Content' as React.ElementType)).toBe(content)
    state.pathname = '/players'
    state.params = { tradeId: 'incoming-trade' }
    await act(async () => screen.update(React.createElement(WebAppShell)))
    expect(controls('Open menu')).toHaveLength(1)
})

it.each([
    { checked: false, draft: null, error: null, visible: true },
    { checked: true, draft: null, error: null, visible: false },
    { checked: true, draft: { id: 'draft-1' }, error: null, visible: true },
    { checked: true, draft: null, error: 'Unavailable', visible: true },
])('uses known draft availability in the menu: %j', async ({ checked, draft, error, visible }) => {
    state.draftChecked = checked
    state.draft = draft
    state.draftError = error
    await render()
    await act(async () => controls('Open menu')[0].props.onPress())
    expect(controls('Draft Room')).toHaveLength(visible ? 1 : 0)
    expect(controls('Playoffs')).toHaveLength(0)
    expect(state.openDraftRoom).not.toHaveBeenCalled()
    await act(async () => controls('Profile & settings')[0].props.onPress())
    expect(state.push).toHaveBeenCalledWith('/profile')
    expect(controls('Profile & settings')).toHaveLength(0)
})
