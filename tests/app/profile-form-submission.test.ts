import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileScreen from '@/app/(tabs)/profile'

const mocks = vi.hoisted(() => ({
    userId: 'user', memberId: 'member',
    teamRenders: [] as { memberId: string; value: unknown }[],
    permission: vi.fn(), pickImage: vi.fn(), uploadAvatar: vi.fn(),
    updateProfile: vi.fn(), updateTeamName: vi.fn(), success: vi.fn(), alert: vi.fn(),
    profile: { display_name: 'Manager', username: 'manager', avatar_url: null },
    preferences: { tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true },
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text',
    TextInput: (props: Record<string, unknown>) => {
        if (props.accessibilityLabel === 'Team name') mocks.teamRenders.push({ memberId: mocks.memberId, value: props.value })
        return React.createElement('TextInput', props)
    }, Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: mocks.permission, launchImageLibraryAsync: mocks.pickImage }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: mocks.memberId, team_name: 'Team' }, currentLeague: { id: `league-${mocks.memberId}` }, refresh: vi.fn() }) }))
vi.mock('@/hooks/use-profile-resource', () => ({ useProfileResource: () => ({
    profile: mocks.profile, profileLoaded: true, preferences: mocks.preferences, setProfile: vi.fn(), setPreferences: vi.fn(),
}) }))
vi.mock('@/lib/auth', () => ({ updateProfile: mocks.updateProfile, signOut: vi.fn(), uploadAvatar: mocks.uploadAvatar }))
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
    mocks.memberId = 'member'
    mocks.teamRenders = []
    mocks.permission.mockResolvedValue({ status: 'granted' })
    mocks.pickImage.mockResolvedValue({ canceled: false, assets: [{ uri: 'fixture.png', width: 1, height: 1 }] })
    mocks.uploadAvatar.mockResolvedValue('http://127.0.0.1/avatar.png')
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


const photo = () => screen.root.findAllByType('Pressable' as React.ElementType)
    .find((node) => node.props.accessibilityLabel === 'Change profile photo')!

it('does not leave the next account photo control busy after an old upload', async () => {
    let finish!: (url: string) => void
    mocks.uploadAvatar.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = photo().props.onPress() })
    mocks.userId = 'next-user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    const busy = photo().props.disabled
    await act(async () => { finish('http://127.0.0.1/old-avatar.png'); await pending })
    expect(busy).toBe(false)
    expect(photo().props.disabled).toBe(false)
    await act(async () => photo().props.onPress())
    expect(mocks.uploadAvatar).toHaveBeenLastCalledWith('next-user', expect.any(Object))
})

it('does not upload a photo selected after its account is replaced', async () => {
    let choose!: (value: { canceled: boolean; assets: { uri: string; width: number; height: number }[] }) => void
    mocks.pickImage.mockReturnValueOnce(new Promise((resolve) => { choose = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = photo().props.onPress() })
    mocks.userId = 'next-user'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => { choose({ canceled: false, assets: [{ uri: 'old.png', width: 1, height: 1 }] }); await pending })
    expect(mocks.uploadAvatar).not.toHaveBeenCalled()
    expect(photo().props.disabled).toBe(false)
})

it('admits one photo picker while permission is pending', async () => {
    let allow!: (value: { status: string }) => void
    mocks.permission.mockReturnValue(new Promise((resolve) => { allow = resolve }))
    mocks.pickImage.mockResolvedValue({ canceled: true })
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => { first = photo().props.onPress(); second = photo().props.onPress() })
    const prompts = mocks.permission.mock.calls.length
    await act(async () => { allow({ status: 'granted' }); await Promise.all([first, second]) })
    expect(prompts).toBe(1)
    expect(photo().props.disabled).toBe(false)
    expect(mocks.uploadAvatar).not.toHaveBeenCalled()
})


it('uses the selected league form value when two teams share a saved name', async () => {
    await act(async () => input('Team name').props.onChangeText('Unsaved first league name'))
    mocks.memberId = 'next-member'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(mocks.updateTeamName).toHaveBeenLastCalledWith('next-member', 'Team')
})


it('hides old league form text before the membership effect runs', async () => {
    await act(async () => input('Team name').props.onChangeText('Unsaved first league name'))
    mocks.memberId = 'next-member'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    const renders = mocks.teamRenders.filter((value) => value.memberId === 'next-member')
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.every((value) => value.value === 'Team')).toBe(true)
})
