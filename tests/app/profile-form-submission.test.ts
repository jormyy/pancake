import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileScreen from '@/app/(tabs)/profile'

const mocks = vi.hoisted(() => ({
    userId: 'user',
    updateProfile: vi.fn(), updateTeamName: vi.fn(), success: vi.fn(), alert: vi.fn(),
    profile: { display_name: 'Manager', username: 'manager', avatar_url: null },
    preferences: { tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true },
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('expo-image-picker', () => ({}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member', team_name: 'Team' }, currentLeague: { id: 'league' }, refresh: vi.fn() }) }))
vi.mock('@/hooks/use-profile-resource', () => ({ useProfileResource: () => ({
    profile: mocks.profile, profileLoaded: true, preferences: mocks.preferences, setProfile: vi.fn(), setPreferences: vi.fn(),
}) }))
vi.mock('@/lib/auth', () => ({ updateProfile: mocks.updateProfile, signOut: vi.fn(), uploadAvatar: vi.fn() }))
vi.mock('@/lib/league', () => ({ updateTeamName: mocks.updateTeamName }))
vi.mock('@/lib/notification-preferences', () => ({ createNotificationPreferenceWriter: () => ({ enqueue: vi.fn() }), updateNotificationPreferences: vi.fn() }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => 1, sessionOwner: () => 'user' }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: vi.fn() }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({
    Button: 'Button', ErrorBanner: 'ErrorBanner', Page: 'Page', SegmentedControl: 'SegmentedControl', usePageMetrics: () => ({ padX: 16 }),
    PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('View', null, actions),
}))
vi.mock('@/components/settings/SettingsGroup', () => ({
    SettingsGroup: 'SettingsGroup', SettingsToggle: 'SettingsToggle',
    SettingsRow: ({ accessory }: { accessory?: React.ReactNode }) => React.createElement('View', null, accessory),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/WebPushSettings', () => ({ WebPushSettings: 'WebPushSettings' }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const button = (title: string) => screen.root.findAllByType('Button' as React.ElementType).find((node) => node.props.title === title)!
const input = (label: string) => screen.root.findAllByType('TextInput' as React.ElementType).find((node) => node.props.accessibilityLabel === label)!
beforeEach(async () => {
    vi.clearAllMocks()
    mocks.userId = 'user'
    mocks.updateProfile.mockResolvedValue(undefined)
    mocks.updateTeamName.mockResolvedValue(undefined)
    await act(async () => { screen = create(React.createElement(ProfileScreen)) })
    await act(async () => button('Edit').props.onPress())
})
afterEach(async () => { await act(async () => screen?.unmount()) })

it('admits one save when the keyboard and button submit during the same pending request', async () => {
    let finish!: () => void
    mocks.updateProfile.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    const keyboard = input('Team name').props.onSubmitEditing
    let pending!: Promise<void>
    await act(async () => { pending = keyboard(); void button('Save').props.onPress() })
    expect(button('Save').props.loading).toBe(true)
    await act(async () => { void input('Team name').props.onSubmitEditing() })
    const requests = [mocks.updateProfile.mock.calls.length, mocks.updateTeamName.mock.calls.length]
    await act(async () => { finish(); await pending })
    expect(requests).toEqual([1, 1])
    expect(mocks.success).toHaveBeenCalledOnce()
})

it('allows correction after validation and another save after a server failure', async () => {
    await act(async () => input('Display name').props.onChangeText(''))
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(mocks.updateProfile).not.toHaveBeenCalled()
    await act(async () => input('Display name').props.onChangeText('Corrected'))
    mocks.updateProfile.mockRejectedValueOnce(new Error('Save failed'))
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(button('Save').props.loading).toBe(false)
    expect(mocks.alert).toHaveBeenLastCalledWith('Error', 'Save failed')
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(mocks.updateProfile).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledOnce()
})

it('does not leave the next account saving while an old account request is pending', async () => {
    let finish!: () => void
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = input('Team name').props.onSubmitEditing() })
    mocks.userId = 'next-user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => button('Edit').props.onPress())
    const busy = button('Save').props.loading
    await act(async () => { finish(); await pending })
    expect(busy).toBe(false)
    expect(button('Save').props.loading).toBe(false)
    expect(mocks.success).not.toHaveBeenCalled()
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(mocks.updateProfile).toHaveBeenLastCalledWith('next-user', { display_name: 'Manager' })
    expect(mocks.success).toHaveBeenCalledOnce()
})

it('keeps the next account save guarded after the old account request finishes', async () => {
    let finishOld!: () => void
    let finishNew!: () => void
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((resolve) => { finishOld = resolve }))
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((resolve) => { finishNew = resolve }))
    let oldRequest!: Promise<void>
    let newRequest!: Promise<void>
    await act(async () => { oldRequest = input('Team name').props.onSubmitEditing() })
    mocks.userId = 'next-user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => button('Edit').props.onPress())
    await act(async () => { newRequest = input('Team name').props.onSubmitEditing() })
    await act(async () => { finishOld(); await oldRequest })
    const busy = button('Save').props.loading
    await act(async () => { void input('Team name').props.onSubmitEditing() })
    const writes = mocks.updateProfile.mock.calls.length
    await act(async () => { finishNew(); await newRequest })
    expect(busy).toBe(true)
    expect(writes).toBe(2)
    expect(mocks.success).toHaveBeenCalledOnce()
})

it('keeps a returning account guarded until its original save completes', async () => {
    let finishOld!: () => void
    let finishNew!: () => void
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((resolve) => { finishOld = resolve }))
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((resolve) => { finishNew = resolve }))
    let oldRequest!: Promise<void>
    let newRequest!: Promise<void>
    await act(async () => { oldRequest = input('Team name').props.onSubmitEditing() })
    mocks.userId = 'next-user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => button('Edit').props.onPress())
    await act(async () => { newRequest = input('Team name').props.onSubmitEditing() })
    mocks.userId = 'user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => button('Edit').props.onPress())
    const busy = button('Save').props.loading
    await act(async () => { void input('Team name').props.onSubmitEditing() })
    const writes = mocks.updateProfile.mock.calls.length
    await act(async () => { finishOld(); finishNew(); await Promise.all([oldRequest, newRequest]) })
    expect(busy).toBe(true)
    expect(writes).toBe(2)
})
