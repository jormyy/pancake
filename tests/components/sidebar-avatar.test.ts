/// <reference path="../../types/react-dom.d.ts" />
import React from 'react'
import Module from 'node:module'
import { WebAppShell } from '@/components/navigation/WebTabShell'
import { updateProfile } from '@/lib/auth'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    userId: 'owner-a', width: 1440, pathname: '/profile', read: vi.fn(), eq: vi.fn(), renders: [] as { owner: string; uri: unknown }[],
    league: { current: null, currentLeague: null, memberships: [], isCommissioner: false } as Record<string, unknown>,
}))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', ScrollView: 'ScrollView', Pressable: 'Pressable', Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: mocks.width, height: 900 }), StyleSheet: { create: (styles: unknown) => styles, flatten: (styles: unknown[]) => Object.assign({}, ...styles.filter(Boolean)) },
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({ Link: 'Link', Navigator: {}, useGlobalSearchParams: () => ({}), usePathname: () => mocks.pathname, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => mocks.league }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/hooks/use-pending-trade-count', () => ({ usePendingTradeCount: () => 0 }))
vi.mock('@/hooks/use-boot-shell-handoff', () => ({ useBootShellHandoff: () => {} }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn(), draftLoading: false }) }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ update: () => ({ eq: mocks.eq }) }) } }))
vi.mock('@/lib/web-push', () => ({}))
vi.mock('@/lib/auth', async original => ({ ...await original<typeof import('@/lib/auth')>(), getProfile: mocks.read }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/components/Avatar', () => ({ Avatar: (props: { uri: unknown }) => {
    mocks.renders.push({ owner: mocks.userId, uri: props.uri })
    return React.createElement('Avatar', props)
} }))


;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const avatar = () => screen.root.findByType('Avatar' as React.ElementType).props.uri
const mount = async () => { await act(async () => { screen = create(React.createElement(WebAppShell, null, null)) }) }
const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
beforeEach(() => {
    vi.clearAllMocks()
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? 1 : originalLoad.call(moduleLoader, name, ...args))
    mocks.userId = 'owner-a'
    mocks.width = 1440
    mocks.pathname = '/profile'
    mocks.renders = []
    mocks.league = { current: null, currentLeague: null, memberships: [], isCommissioner: false, membershipStatus: 'loading' }
    mocks.read.mockResolvedValue({ avatar_url: 'a.png' })
    mocks.eq.mockResolvedValue({ error: null })
})

it.each([1440, 390])('reserves the league switch geometry before identity resolves at width %s', async width => {
    mocks.width = width
    mocks.pathname = '/'
    await mount()
    expect(screen.root.findAllByProps({ children: 'League unavailable' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'Waiting for league access' })).toHaveLength(0)
    const placeholder = screen.root.findAllByType('Text' as React.ElementType).find(node => node.props.children === '\u00a0')!
    const beforeSwitch = placeholder.parent!.parent!
    const beforeWrapper = beforeSwitch.parent!
    const flatten = (style: unknown) => Object.assign({}, ...(Array.isArray(style) ? style.filter(Boolean) : [style]))
    const before = flatten(beforeSwitch.props.style)
    const wrapper = flatten(beforeWrapper.props.style)
    mocks.league = {
        current: { id: 'member', team_name: 'A team', leagues: { name: 'A long league name that fills both lines' } },
        currentLeague: { id: 'league' }, memberships: [], isCommissioner: true,
    }
    await act(async () => screen.update(React.createElement(WebAppShell, null, null)))
    const title = screen.root.findByProps({ children: 'A long league name that fills both lines' })
    const titleBox = title.parent!.parent!
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Switch league' })).toHaveLength(0)
    expect(flatten(titleBox.props.style).height).toBe(before.height)
    expect(flatten(titleBox.parent!.props.style)).toEqual(wrapper)
    expect(before.height).toBe(width === 390 ? 44 : 68)
})

it.each(['loading', 'available', 'signed-out'])('keeps unresolved league access neutral for %s', async membershipStatus => {
    mocks.league.membershipStatus = membershipStatus
    await mount()
    expect(screen.root.findAllByProps({ children: 'League unavailable' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'Waiting for league access' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ children: 'No league' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ 'aria-busy': true })).toHaveLength(1)
})

it.each([
    ['empty', 'No league', 'Create or join from League'],
    ['unavailable', 'League unavailable', 'Waiting for league access'],
])('shows the confirmed league state for %s', async (membershipStatus, name, detail) => {
    mocks.league.membershipStatus = membershipStatus
    await mount()
    expect(screen.root.findAllByProps({ children: name })).toHaveLength(1)
    expect(screen.root.findAllByProps({ children: detail })).toHaveLength(1)
    expect(screen.root.findAllByProps({ 'aria-busy': true })).toHaveLength(0)
})
it.each(['/profile', '/player/player-a', '/propose-trade'])('hides the global top bar on the pushed route %s', async pathname => {
    mocks.width = 390
    mocks.pathname = '/'
    await mount()
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Open menu' })).toHaveLength(1)
    mocks.pathname = pathname
    await act(async () => screen.update(React.createElement(WebAppShell, null, null)))
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Open menu' })).toHaveLength(0)
    expect(screen.root.findAllByProps({ 'aria-label': 'Primary' })).toHaveLength(1)
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

describe('sidebar profile authority', () => {
    it('shows a committed avatar without reloading the page or rereading the profile', async () => {
        await mount()
        expect(avatar()).toBe('a.png')
        await act(async () => { await updateProfile('owner-a', { avatar_url: 'new.png' }) })
        expect(avatar()).toBe('new.png')
        expect(mocks.read).toHaveBeenCalledOnce()
    })

    it('never renders the old account avatar while the new profile is pending', async () => {
        await mount()
        const next = deferred<{ avatar_url: string }>()
        mocks.read.mockReturnValueOnce(next.promise)
        mocks.userId = 'owner-b'
        await act(async () => { screen.update(React.createElement(WebAppShell, null, null)) })
        const before = mocks.renders.filter(row => row.owner === 'owner-b').map(row => row.uri)
        await act(async () => { next.resolve({ avatar_url: 'b.png' }); await next.promise })
        expect(before.every(uri => uri === null)).toBe(true)
        expect(avatar()).toBe('b.png')
    })

    it('does not overwrite a newer committed avatar with the earlier initial read', async () => {
        const old = deferred<{ avatar_url: string }>()
        mocks.read.mockReturnValueOnce(old.promise)
        await mount()
        await act(async () => { await updateProfile('owner-a', { avatar_url: 'committed.png' }) })
        await act(async () => { old.resolve({ avatar_url: 'old.png' }); await old.promise })
        expect(avatar()).toBe('committed.png')
    })

    it('ignores failed writes and updates belonging to another account', async () => {
        await mount()
        mocks.eq.mockResolvedValueOnce({ error: new Error('Write refused') })
        await act(async () => { await expect(updateProfile('owner-a', { avatar_url: 'failed.png' })).rejects.toThrow('Write refused') })
        await act(async () => { await updateProfile('owner-b', { avatar_url: 'b.png' }) })
        expect(avatar()).toBe('a.png')
    })
})

it.each([1440, 390])('keeps the route subtree mounted when authentication changes chrome at width %s', async width => {
    mocks.width = width
    let mounts = 0
    const Route = () => {
        const [value, setValue] = React.useState('')
        React.useEffect(() => { mounts += 1 }, [])
        return React.createElement('Route', { value, onChange: setValue })
    }
    const render = (chrome: boolean) => React.createElement(WebAppShell, { chrome }, React.createElement(Route))
    await act(async () => { screen = create(render(true)) })
    await act(async () => { screen.root.findByType('Route' as React.ElementType).props.onChange('navigation state') })
    await act(async () => { screen.update(render(false)) })
    const paused = screen.root.findByType('Route' as React.ElementType).props.value
    await act(async () => { screen.update(render(true)) })
    expect(paused).toBe('navigation state')
    expect(screen.root.findByType('Route' as React.ElementType).props.value).toBe('navigation state')
    expect(mounts).toBe(1)
})

it('dismisses root pages when using a desktop tab link', async () => {
    mocks.pathname = '/player/player-a'
    await mount()
    const links = screen.root.findAllByType('Link' as React.ElementType)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link.props.dismissTo).toBe(true)
})
