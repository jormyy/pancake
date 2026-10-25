import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RootLayout, * as RootExports from '@/app/_layout'
import * as ModalExports from '@/app/(modals)/_layout'

const navigation = vi.hoisted(() => ({ ready: false, authenticated: false, replace: vi.fn() }))

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, ThemeProvider: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/constants/fonts', () => ({ criticalFonts: {} }))
vi.mock('@expo-google-fonts/outfit', () => ({ Outfit_500Medium: 500, Outfit_600SemiBold: 600, Outfit_700Bold: 700 }))
vi.mock('expo-font', () => ({ useFonts: () => [], FontDisplay: { SWAP: 'swap' } }))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('@/hooks/use-auth', () => ({ AuthProvider: ({ children }: React.PropsWithChildren) => children, useAuth: () => ({ session: navigation.authenticated ? {} : null, loading: false }) }))
vi.mock('@/contexts/league-context', () => ({ LeagueProvider: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/hooks/use-web-push-notifications', () => ({ useWebPushNotifications: () => {} }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui', () => ({ FeedbackProvider: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/auth/AuthHydrationFrame', () => ({ AuthHydrationFrame: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/LeagueAccessNotice', () => ({ LeagueAccessNotice: () => null }))
vi.mock('@/components/navigation/WebTabShell', () => ({ WebAppShell: ({ children }: React.PropsWithChildren) => children }))
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: navigation.replace }), useSegments: () => ['(auth)', 'sign-in'],
    Stack: Object.assign(({ children }: React.PropsWithChildren) => {
        const [ready, setReady] = React.useState(false)
        navigation.ready = ready
        React.useEffect(() => { setReady(true) }, [])
        return children
    }, { Screen: 'Screen' }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

beforeEach(() => {
    navigation.ready = false
    navigation.authenticated = false
    navigation.replace.mockReset().mockImplementation(() => {
        if (!navigation.ready) throw new Error('Navigation is not mounted')
    })
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })

it('suppresses the unmatched-route header before the route mounts', async () => {
    await act(async () => { screen = create(React.createElement(RootLayout)) })
    expect(screen.root.findByProps({ name: '+not-found' }).props.options.headerShown).toBe(false)
})

it('waits for the navigator to mount before redirecting a cached session', async () => {
    navigation.authenticated = true
    await act(async () => { screen = create(React.createElement(RootLayout)) })
    expect(navigation.replace).toHaveBeenCalledWith('/')
})


it('suppresses the player header before the lazy route mounts', async () => {
    await act(async () => { screen = create(React.createElement(RootLayout)) })
    expect(screen.root.findByProps({ name: 'player/[id]' }).props.options?.headerShown).toBe(false)
})

it.each([['root', RootExports], ['modals', ModalExports]])('offers a reload for a failed lazy route under %s', async (_name, layout) => {
    const reload = vi.fn()
    const retry = vi.fn(async () => {})
    vi.stubGlobal('window', { location: { reload } })
    const Boundary = (layout as { ErrorBoundary?: React.ComponentType<{ error: Error; retry: () => Promise<void> }> }).ErrorBoundary
    expect(Boundary).toEqual(expect.any(Function))
    await act(async () => { screen = create(React.createElement(Boundary!, { error: new Error('Loading module failed'), retry })) })
    const fallback = screen.root.findByType('EmptyState' as React.ElementType)
    expect(fallback.props.actionLabel).toBe('Reload')
    await act(async () => fallback.props.onAction())
    expect(reload).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
})

it.each([['root', RootExports], ['modals', ModalExports]])('retries a failed route under %s without a browser', async (_name, layout) => {
    vi.stubGlobal('window', undefined)
    const retry = vi.fn(async () => {})
    const Boundary = (layout as { ErrorBoundary?: React.ComponentType<{ error: Error; retry: () => Promise<void> }> }).ErrorBoundary
    expect(Boundary).toEqual(expect.any(Function))
    await act(async () => { screen = create(React.createElement(Boundary!, { error: new Error('Unavailable module'), retry })) })
    await act(async () => screen.root.findByType('EmptyState' as React.ElementType).props.onAction())
    expect(retry).toHaveBeenCalledOnce()
})
