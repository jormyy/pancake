import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileScreen from '@/app/(tabs)/profile'
import NotificationSettingsScreen from '@/app/(modals)/notification-settings'
import { NotificationSettings } from '@/components/settings/NotificationSettings'
import { Button } from '@/components/ui'
import { SettingsRow } from '@/components/settings/SettingsGroup'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { signOut } from '@/lib/auth'
import { enableWebPush, getWebPushStatus } from '@/lib/web-push'
import { showAlert, confirmAction } from '@/lib/alert'

const auth = vi.hoisted(() => ({ user: { id: 'owner-a', email: 'synthetic@example.invalid' }, ready: true, tradeEnabled: true }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value },
    View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable',
    ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), Stack: { Screen: 'Stack.Screen' } }))
vi.mock('expo-image-picker', () => ({}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/ui', () => ({
    Button: 'Button', ErrorBanner: 'ErrorBanner', Page: 'Page', PageHeader: 'PageHeader',
    SegmentedControl: 'SegmentedControl', usePageMetrics: () => ({ padX: 16 }),
}))
vi.mock('@/components/settings/SettingsGroup', () => ({
    SettingsGroup: 'SettingsGroup', SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle',
}))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: null, currentLeague: null, loading: false, refresh: vi.fn() }) }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/hooks/use-profile-resource', () => ({ useProfileResource: () => ({
    profile: { display_name: 'Synthetic' }, profileLoaded: auth.ready, profileError: null,
    preferences: { tradeEnabled: auth.tradeEnabled, waiverEnabled: true, draftEnabled: true, activityEnabled: true },
    retryProfile: vi.fn(), setProfile: vi.fn(), setPreferences: vi.fn(),
}) }))
vi.mock('@/lib/auth', () => ({ updateProfile: vi.fn(), uploadAvatar: vi.fn(), signOut: vi.fn() }))
vi.mock('@/lib/league', () => ({ updateTeamName: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/notification-preferences', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/notification-preferences')>(), updateNotificationPreferences: vi.fn(),
}))
vi.mock('@/lib/theme-preference', () => ({ DEFAULT_THEME: 'light', readThemePreference: () => 'light', setThemePreference: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), showSuccess: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/web-push', () => ({
    enableWebPush: vi.fn(), disableWebPush: vi.fn(), getWebPushStatus: vi.fn(),
    getWebPushPublicKey: vi.fn(async () => 'synthetic-public-key'), sendTestWebPush: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function button(renderer: ReactTestRenderer, title: string) {
    const found = renderer.root.findAllByType(Button).find(node => node.props.title === title)
    if (!found) throw new Error(`Missing button: ${title}`)
    return found
}
const preferencePanels = (renderer: ReactTestRenderer) => renderer.root.findAllByType(NotificationSettings)
let mounted: ReactTestRenderer | undefined

afterEach(async () => {
    if (mounted) await act(async () => { mounted?.unmount() })
    mounted = undefined
})

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(enableWebPush).mockReset()
    vi.mocked(getWebPushStatus).mockReset()
    auth.user = { id: 'owner-a', email: 'synthetic@example.invalid' }
    auth.ready = true
    auth.tradeEnabled = true
    setSessionOwner('owner-a')
})

it.each(['owner-b', 'owner-a'])('refreshes a mounted notification modal push control for a new session of %s', async nextOwner => {
    const pending = deferred<'on'>()
    vi.mocked(getWebPushStatus).mockResolvedValue('off')
    vi.mocked(enableWebPush).mockReturnValueOnce(pending.promise).mockResolvedValueOnce('on')
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(NotificationSettingsScreen)); mounted = renderer })
    await act(async () => { button(renderer, 'Turn on').props.onPress() })
    expect(button(renderer, 'Turn on').props.loading).toBe(true)
    setSessionOwner(null)
    setSessionOwner(nextOwner)
    auth.user = { id: nextOwner, email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(NotificationSettingsScreen)) })
    expect(getWebPushStatus).toHaveBeenCalledTimes(2)
    expect(button(renderer, 'Turn on').props.loading).toBe(false)
    await act(async () => { pending.reject(new Error('Previous session failed')) })
    expect(showAlert).not.toHaveBeenCalled()
    await act(async () => { button(renderer, 'Turn on').props.onPress() })
    expect(button(renderer, 'Turn off')).toBeDefined()
    expect(preferencePanels(renderer)).toHaveLength(1)
    await act(async () => { renderer.unmount() })
})

it('hides the old subscription preferences while the next owner status is unresolved', async () => {
    const nextStatus = deferred<'off'>()
    auth.tradeEnabled = false
    vi.mocked(getWebPushStatus).mockResolvedValueOnce('on').mockReturnValueOnce(nextStatus.promise)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(NotificationSettingsScreen)); mounted = renderer })
    expect(preferencePanels(renderer)).toHaveLength(1)
    expect(preferencePanels(renderer)[0].props.preferences.tradeEnabled).toBe(false)
    auth.ready = false
    setSessionOwner('owner-b')
    auth.user = { id: 'owner-b', email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(NotificationSettingsScreen)) })
    expect(preferencePanels(renderer)).toHaveLength(0)
    expect(renderer.root.findAllByType(Button).some(node => node.props.title === 'Turn off')).toBe(false)
    auth.ready = true
    auth.tradeEnabled = true
    await act(async () => { nextStatus.resolve('off'); renderer.update(React.createElement(NotificationSettingsScreen)) })
    expect(button(renderer, 'Turn on')).toBeDefined()
    expect(preferencePanels(renderer)).toHaveLength(1)
    expect(preferencePanels(renderer)[0].props.preferences.tradeEnabled).toBe(true)
    await act(async () => { renderer.unmount() })
})


it('does not show a failed old logout on the next owner screen', async () => {
    const pending = deferred<{ serverSignOutConfirmed: boolean }>()
    vi.mocked(signOut).mockReturnValueOnce(pending.promise)
    vi.mocked(getWebPushStatus).mockResolvedValue('off')
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProfileScreen)); mounted = renderer })
    await act(async () => { renderer.root.findAllByType(SettingsRow).find(node => node.props.label === 'Sign out')!.props.onPress() })
    let action!: Promise<unknown>
    await act(async () => { action = Promise.resolve(vi.mocked(confirmAction).mock.calls.at(-1)![2]()) })
    setSessionOwner('owner-b')
    auth.user = { id: 'owner-b', email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(ProfileScreen)) })
    await act(async () => { pending.reject(new Error('Your account changed')); await action })
    expect(showAlert).not.toHaveBeenCalled()
})

it('does not confirm logout for an account that replaced the confirmation owner', async () => {
    vi.mocked(getWebPushStatus).mockResolvedValue('off')
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProfileScreen)); mounted = renderer })
    await act(async () => { renderer.root.findAllByType(SettingsRow).find(node => node.props.label === 'Sign out')!.props.onPress() })
    setSessionOwner('owner-b')
    auth.user = { id: 'owner-b', email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(ProfileScreen)) })
    await act(async () => { await vi.mocked(confirmAction).mock.calls.at(-1)![2]() })
    expect(signOut).not.toHaveBeenCalled()
})

it('keeps the local-only logout warning after the initiating account signs out', async () => {
    vi.mocked(signOut).mockImplementationOnce(async () => { setSessionOwner(null); return { serverSignOutConfirmed: false } })
    vi.mocked(getWebPushStatus).mockResolvedValue('off')
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProfileScreen)); mounted = renderer })
    await act(async () => { renderer.root.findAllByType(SettingsRow).find(node => node.props.label === 'Sign out')!.props.onPress() })
    await act(async () => { await vi.mocked(confirmAction).mock.calls.at(-1)![2]() })
    expect(showAlert).toHaveBeenCalledWith('Signed out on this device', expect.stringContaining('Other sessions may still be signed in'))
})
