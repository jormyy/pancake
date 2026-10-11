import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileScreen from '@/app/(tabs)/profile'
import { Button } from '@/components/ui'
import { SettingsRow } from '@/components/settings/SettingsGroup'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { enableWebPush, getWebPushStatus } from '@/lib/web-push'
import { showAlert } from '@/lib/alert'

const auth = vi.hoisted(() => ({ user: { id: 'owner-a', email: 'synthetic@example.invalid' } }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value },
    View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable',
    ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
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
vi.mock('@/hooks/use-profile-resource', () => ({ useProfileResource: () => ({
    profile: { display_name: 'Synthetic' }, profileLoaded: true, profileError: null,
    preferences: { tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true },
    retryProfile: vi.fn(), setProfile: vi.fn(), setPreferences: vi.fn(),
}) }))
vi.mock('@/lib/auth', () => ({ updateProfile: vi.fn(), uploadAvatar: vi.fn(), signOut: vi.fn() }))
vi.mock('@/lib/league', () => ({ updateTeamName: vi.fn() }))
vi.mock('@/lib/notification-preferences', () => ({
    createNotificationPreferenceWriter: () => ({ enqueue: vi.fn() }), updateNotificationPreferences: vi.fn(),
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
const preferenceRows = (renderer: ReactTestRenderer) => renderer.root.findAllByType(SettingsRow).filter(node => node.props.role === 'switch')
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
    setSessionOwner('owner-a')
})

it.each(['owner-b', 'owner-a'])('refreshes a mounted Profile push control for a new session of %s', async nextOwner => {
    const pending = deferred<'on'>()
    vi.mocked(getWebPushStatus).mockResolvedValue('off')
    vi.mocked(enableWebPush).mockReturnValueOnce(pending.promise).mockResolvedValueOnce('on')
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProfileScreen)); mounted = renderer })
    await act(async () => { button(renderer, 'Turn on').props.onPress() })
    expect(button(renderer, 'Turn on').props.loading).toBe(true)
    setSessionOwner(null)
    setSessionOwner(nextOwner)
    auth.user = { id: nextOwner, email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(ProfileScreen)) })
    expect(getWebPushStatus).toHaveBeenCalledTimes(2)
    expect(button(renderer, 'Turn on').props.loading).toBe(false)
    await act(async () => { pending.reject(new Error('Previous session failed')) })
    expect(showAlert).not.toHaveBeenCalled()
    await act(async () => { button(renderer, 'Turn on').props.onPress() })
    expect(button(renderer, 'Turn off')).toBeDefined()
    expect(preferenceRows(renderer)).toHaveLength(4)
    await act(async () => { renderer.unmount() })
})

it('hides the old subscription preferences while the next owner status is unresolved', async () => {
    const nextStatus = deferred<'off'>()
    vi.mocked(getWebPushStatus).mockResolvedValueOnce('on').mockReturnValueOnce(nextStatus.promise)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(ProfileScreen)); mounted = renderer })
    expect(preferenceRows(renderer)).toHaveLength(4)
    setSessionOwner('owner-b')
    auth.user = { id: 'owner-b', email: 'synthetic-next@example.invalid' }
    await act(async () => { renderer.update(React.createElement(ProfileScreen)) })
    expect(preferenceRows(renderer)).toHaveLength(0)
    expect(renderer.root.findAllByType(Button).some(node => node.props.title === 'Turn off')).toBe(false)
    await act(async () => { nextStatus.resolve('off') })
    expect(button(renderer, 'Turn on')).toBeDefined()
    expect(preferenceRows(renderer)).toHaveLength(0)
    await act(async () => { renderer.unmount() })
})
