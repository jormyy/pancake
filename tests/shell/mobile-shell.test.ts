import React from 'react'
import Module from 'node:module'
import { load as loadHtml } from 'cheerio'
import { BOOT_SHELL_HTML } from '@/constants/boot-shell'
import type { StackNavigationState } from '@react-navigation/native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebAppShell } from '@/components/navigation/WebTabShell'

const state = vi.hoisted(() => {
    const current = { id: 'member-1', team_name: 'Team One', leagues: { id: 'league-1', name: 'Sunday Dynasty' } }
    return {
        pathname: '/', params: {} as { tradeId?: string }, current, memberships: [current], setCurrent: vi.fn(),
        draft: null as { id: string } | null, draftChecked: false, draftError: null as string | null,
        openDraftRoom: vi.fn(), push: vi.fn(), navigate: vi.fn(), dismissTo: vi.fn(),
    }
})

vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, flatten: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({
    usePathname: () => state.pathname, useGlobalSearchParams: () => state.params, useRouter: () => ({ push: state.push, navigate: state.navigate, dismissTo: state.dismissTo }), Link: 'Link', Navigator: 'Navigator',
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
    await act(async () => { screen = create(React.createElement(WebAppShell, {}, React.createElement('Content')), { createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 56, top: 0, width: 280, height: 44 }), focus: vi.fn() }) }) })
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

it('opens the switch with one league and keeps it when another league becomes available', async () => {
    await render()
    expect(controls('Switch league')).toHaveLength(1)
    expect(screen.root.findAll(node => node.type === ('Text' as React.ElementType) && node.props.children === 'Sunday Dynasty')).toHaveLength(1)
    state.memberships = [state.current, { ...state.current, id: 'member-2', leagues: { id: 'league-2', name: 'Second League' } }]
    await act(async () => screen.update(React.createElement(WebAppShell)))
    expect(controls('Switch league')).toHaveLength(1)
    expect(controls('Switch league')[0].props.onPress).toEqual(expect.any(Function))
})

it.each([
    '/player/123', '/lineup', '/propose-trade', '/claim-player', '/team-roster', '/change-password',
    '/commissioner-settings', '/create-league', '/join-league', '/bracket', '/draft', '/draft-room', '/rookie-draft-room', '/profile', '/notification-settings',
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

it.each(['/', '/roster', '/players', '/trades', '/league'])('ignores the active bottom tab at %s', async pathname => {
    state.pathname = pathname
    await render()
    const active = screen.root.find(node => node.type === ('Pressable' as React.ElementType)
        && node.props.accessibilityRole === 'link' && node.props.accessibilityState.selected)
    await act(async () => active.props.onPress())
    expect(state.push).not.toHaveBeenCalled()
    expect(state.navigate).not.toHaveBeenCalled()
    expect(state.dismissTo).not.toHaveBeenCalled()
})

it('navigates to another bottom tab without pushing a new history entry', async () => {
    await render()
    await act(async () => controls('Roster')[0].props.onPress())
    expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith('/roster')
    expect(state.push).not.toHaveBeenCalled()
})

it.each([
    ['/lineup', 'Roster', '/roster'],
    ['/player/123', 'Players', '/players'],
    ['/claim-player', 'Players', '/players'],
    ['/propose-trade', 'Trades', '/trades'],
    ['/team-roster', 'League', '/league'],
])('returns from %s to its selected bottom tab', async (pathname, label, href) => {
    state.pathname = pathname
    await render()
    expect(controls(label)[0].props.accessibilityState.selected).toBe(true)
    await act(async () => controls(label)[0].props.onPress())
    expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith(href)
    expect(state.push).not.toHaveBeenCalled()
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
    expect(state.dismissTo).toHaveBeenCalledWith('/profile')
    expect(state.push).not.toHaveBeenCalled()
    expect(controls('Profile & settings')).toHaveLength(0)
})

it('dismisses the trade detail when its already-selected tab is tapped', async () => {
    state.pathname = '/trades'
    state.params = { tradeId: 'incoming-trade' }
    let tabs: StackNavigationState<Record<string, object | undefined>> = {
        stale: false, type: 'stack', key: 'tabs', index: 1, routeNames: ['index', 'trades'],
        routes: [{ key: 'home', name: 'index' }, { key: 'trades', name: 'trades', params: state.params }],
        preloadedRoutes: [],
    }
    state.dismissTo.mockImplementation(() => {
        tabs = { ...tabs, routes: [tabs.routes[0], { ...tabs.routes[1], params: {} }] }
    })
    await render()
    await act(async () => controls('Trades')[0].props.onPress())
    expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith('/trades')
    expect(tabs.routes[tabs.index].params).not.toHaveProperty('tradeId')
})

it('reuses the original tabs tree after repeated root-level player visits', async () => {
    let root: StackNavigationState<Record<string, object | undefined>> = {
        stale: false, type: 'stack', key: 'root', index: 0, routeNames: ['(tabs)', 'player/[id]'],
        routes: [{ key: 'original-tabs', name: '(tabs)' }], preloadedRoutes: [],
    }
    const originalTabs = root.routes[0].key
    state.navigate.mockImplementation(() => {
        root = { ...root, index: root.routes.length, routes: [...root.routes, { key: 'new-tabs', name: '(tabs)' }] }
    })
    state.dismissTo.mockImplementation(() => { root = { ...root, index: 0, routes: [root.routes[0]] } })
    state.pathname = '/player/123'
    await render()
    for (const id of ['1', '2']) {
        root = { ...root, index: root.routes.length, routes: [...root.routes, { key: `player-${id}`, name: 'player/[id]', params: { id } }] }
        await act(async () => controls('Players')[0].props.onPress())
        expect(root.routes.map(route => route.name)).toEqual(['(tabs)'])
        expect(root.routes[0].key).toBe(originalTabs)
    }
})

it('names the notification settings page in the browser title', async () => {
    const page = { title: '', getElementById: () => ({}) }
    vi.stubGlobal('document', page)
    try {
        state.pathname = '/notification-settings'
        await render()
        expect(page.title).toBe('Notifications · Pancake')
    } finally { vi.unstubAllGlobals() }
})

it.each(['Join with Invite Code', 'Create a League'])('opens the existing %s flow from the single-league menu', async label => {
    vi.stubGlobal('document', { body: {}, title: '', getElementById: () => ({}), addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    try {
        await render()
        await act(async () => controls('Switch league')[0].props.onPress())
        expect(controls('Switch to Sunday Dynasty')[0].props.accessibilityState.selected).toBe(true)
        expect(controls('Join or create a league')).toHaveLength(1)
        await act(async () => controls('Join or create a league')[0].props.onPress())
        await act(async () => controls(label)[0].props.onPress())
        expect(state.push).toHaveBeenCalledExactlyOnceWith(label === 'Create a League' ? '/(modals)/create-league' : '/(modals)/join-league')
    } finally { vi.unstubAllGlobals() }
})

it('keeps primary navigation ordered and reachable before and after the app mounts', async () => {
    await render()
    const routes = ['/', '/roster', '/players', '/trades', '/league']
    const links = screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityRole === 'link')
    expect(links.map(link => link.props.accessibilityLabel)).toEqual(['Matchup', 'Roster', 'Players', 'Trades', 'League'])
    state.pathname = '/profile'
    await act(async () => screen.update(React.createElement(WebAppShell)))
    for (const [index, route] of routes.entries()) {
        const links = screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityRole === 'link')
        await act(async () => links[index].props.onPress())
        expect(state.dismissTo).toHaveBeenLastCalledWith(route)
    }
    state.pathname = '/'
    await act(async () => screen.update(React.createElement(WebAppShell)))
    const boot = loadHtml(BOOT_SHELL_HTML)
    const navigation = boot('nav[aria-label="Primary"]')
    expect(navigation).toHaveLength(2)
    navigation.each((_index, node) => {
        const links = boot(node).find('a')
        expect(links.map((_index, link) => boot(link).attr('href')).get().filter(href => routes.includes(href))).toEqual(routes)
        expect(links.filter('[aria-hidden="true"]')).toHaveLength(0)
    })
    await act(async () => controls('Open menu')[0].props.onPress())
    await act(async () => controls('Profile & settings')[0].props.onPress())
    expect(state.dismissTo).toHaveBeenCalledWith('/profile')
})
