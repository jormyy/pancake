import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileScreen from '@/app/(tabs)/profile'
import NotificationSettingsScreen from '@/app/(modals)/notification-settings'

const mocks = vi.hoisted(() => ({
    userId: 'user', memberId: 'member', teamName: 'Team', serverTeam: 'Team', platform: 'web',
    retryProfile: vi.fn(), refresh: vi.fn(),
    receiveProfile: null as null | ((profile: { display_name: string; username: string; avatar_url: null }) => void),
    updatePreferences: vi.fn(),
    getPreferences: vi.fn(),
    teamRenders: [] as { memberId: string; value: unknown }[],
    permission: vi.fn(), pickImage: vi.fn(), uploadAvatar: vi.fn(),
    updateProfile: vi.fn(), updateTeamName: vi.fn(), success: vi.fn(), alert: vi.fn(),
    profile: { display_name: 'Manager', username: 'manager', avatar_url: null },
    preferences: { tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true },
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({
    Platform: { get OS() { return mocks.platform } }, View: 'View', Text: 'Text',
    TextInput: (props: Record<string, unknown>) => {
        if (props.accessibilityLabel === 'Team name') mocks.teamRenders.push({ memberId: mocks.memberId, value: props.value })
        return React.createElement('TextInput', props)
    }, Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), Stack: { Screen: 'Stack.Screen' } }))
vi.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: mocks.permission, launchImageLibraryAsync: mocks.pickImage }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: mocks.memberId, team_name: mocks.teamName }, currentLeague: { id: `league-${mocks.memberId}` }, refresh: mocks.refresh }) }))
vi.mock('@/hooks/use-profile-resource', () => ({ useProfileResource: function useProfileResource() {
    const [preferences, setPreferences] = React.useState(mocks.preferences)
    const [profile, setProfile] = React.useState(mocks.profile)
    mocks.receiveProfile = setProfile
    return {
        profile, profileLoaded: true, preferences, setProfile, setPreferences,
        retryProfile: async () => { mocks.retryProfile(); setProfile(mocks.profile); setPreferences(await mocks.getPreferences()) },
    }
} }))
vi.mock('@/lib/auth', () => ({ updateProfile: mocks.updateProfile, signOut: vi.fn(), uploadAvatar: mocks.uploadAvatar }))
vi.mock('@/lib/league', () => ({ updateTeamName: mocks.updateTeamName }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/notification-preferences', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/notification-preferences')>(), updateNotificationPreferences: mocks.updatePreferences }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => 1, sessionOwner: () => 'user' }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: vi.fn() }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({
    Button: 'Button', ErrorBanner: 'ErrorBanner', Page: 'Page', SegmentedControl: 'SegmentedControl', usePageMetrics: () => ({ padX: 16 }),
    PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('View', null, actions),
}))
vi.mock('@/components/settings/SettingsGroup', () => ({
    SettingsGroup: 'SettingsGroup', SettingsToggle: 'SettingsToggle',
    SettingsRow: (props: { accessory?: React.ReactNode }) => React.createElement('SettingsRow', props, props.accessory),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/components/WebPushSettings', () => ({ WebPushSettings: 'WebPushSettings' }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const button = (title: string) => screen.root.findAllByType('Button' as React.ElementType).find((node) => node.props.title === title)!
const input = (label: string) => screen.root.findAllByType('TextInput' as React.ElementType).find((node) => node.props.accessibilityLabel === label)!
beforeEach(async () => {
    vi.clearAllMocks()
    mocks.getPreferences.mockResolvedValue(mocks.preferences)
    mocks.platform = 'web'
    mocks.userId = 'user'
    mocks.memberId = 'member'
    mocks.teamName = 'Team'
    mocks.serverTeam = 'Team'
    mocks.profile = { display_name: 'Manager', username: 'manager', avatar_url: null }
    mocks.refresh.mockImplementation(async () => { mocks.teamName = mocks.serverTeam })
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
    expect(requests).toEqual([1, 0])
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
    mocks.getPreferences.mockResolvedValue(mocks.preferences)
    mocks.platform = 'web'
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
    expect(input('Team name').props.value).toBe('Team')
    await act(async () => input('Team name').props.onSubmitEditing())
    expect(mocks.updateTeamName).not.toHaveBeenCalled()
})


it('hides old league form text before the membership effect runs', async () => {
    await act(async () => input('Team name').props.onChangeText('Unsaved first league name'))
    mocks.memberId = 'next-member'
    await act(async () => { screen.update(React.createElement(ProfileScreen)) })
    const renders = mocks.teamRenders.filter((value) => value.memberId === 'next-member')
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.every((value) => value.value === 'Team')).toBe(true)
})


it.each([[false, false], [true, false], [false, true], [true, true]])(
    'reconciles queued preferences when saves succeed as %s then %s', async (firstSucceeds, secondSucceeds) => {
        mocks.platform = 'ios'
        await act(async () => { screen.update(React.createElement(NotificationSettingsScreen)) })
        const setting = (category: string) => screen.root.findAllByType('Pressable' as React.ElementType)
            .find(node => node.props.accessibilityLabel === `All ${category.toLowerCase()} notifications`)!
        const persisted = { ...mocks.preferences }
        mocks.getPreferences.mockImplementation(async () => ({ ...persisted }))
        let finishFirst!: () => void
        let finishSecond!: () => void
        mocks.updatePreferences.mockImplementationOnce((_owner, value) => new Promise<void>((resolve, reject) => {
            finishFirst = () => {
                if (firstSucceeds) { Object.assign(persisted, value); resolve() }
                else reject(new Error('First save failed'))
            }
        })).mockImplementationOnce((_owner, value) => new Promise<void>((resolve, reject) => {
            finishSecond = () => {
                if (secondSucceeds) { Object.assign(persisted, value); resolve() }
                else reject(new Error('Second save failed'))
            }
        }))
        await act(async () => { setting('Trades').props.onPress(); setting('Waivers').props.onPress() })
        expect(mocks.updatePreferences).toHaveBeenCalledTimes(1)
        expect(setting('Trades').props['aria-checked']).toBe(false)
        expect(setting('Waivers').props['aria-checked']).toBe(false)
        await act(async () => { finishFirst(); await Promise.resolve() })
        expect(mocks.updatePreferences).toHaveBeenCalledTimes(2)
        await act(async () => { finishSecond(); await Promise.resolve() })
        expect(setting('Trades').props['aria-checked']).toBe(!(firstSucceeds || secondSucceeds))
        expect(setting('Waivers').props['aria-checked']).toBe(!secondSucceeds)
    },
)


it('reconciles a successful profile write after the team write fails first', async () => {
    let finish!: () => void
    mocks.updateProfile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => {
        mocks.profile = { ...mocks.profile, display_name: 'Committed name' }
        resolve()
    } }))
    mocks.updateTeamName.mockRejectedValueOnce(new Error('Team save failed'))
    await act(async () => { input('Display name').props.onChangeText('Committed name'); input('Team name').props.onChangeText('New team') })
    await act(async () => input('Team name').props.onChangeText('Unsaved team'))
    let pending!: Promise<void>
    await act(async () => { pending = input('Team name').props.onSubmitEditing(); await Promise.resolve() })
    const prematureError = mocks.alert.mock.calls.length
    const prematureIdle = !button('Save').props.loading
    await act(async () => { finish(); await pending })
    expect(prematureError).toBe(0)
    expect(prematureIdle).toBe(false)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenLastCalledWith('Error', 'Team save failed')
    await act(async () => { button('Cancel')?.props.onPress() })
    await act(async () => { button('Edit').props.onPress() })
    expect(input('Display name').props.value).toBe('Committed name')
    expect(input('Team name').props.value).toBe('Team')
})

it('reconciles a successful team write after the profile write fails', async () => {
    mocks.updateProfile.mockRejectedValueOnce(new Error('Profile save failed'))
    mocks.updateTeamName.mockImplementationOnce(async () => { mocks.serverTeam = 'Committed team' })
    await act(async () => input('Team name').props.onChangeText('Committed team'))
    await act(async () => input('Team name').props.onSubmitEditing())
    await act(async () => button('Cancel')?.props.onPress())
    await act(async () => button('Edit').props.onPress())
    expect(input('Team name').props.value).toBe('Committed team')
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenLastCalledWith('Error', 'Profile save failed')
})

it('does not reconcile or report an old account failure into the new account', async () => {
    let fail!: (error: Error) => void
    mocks.updateProfile.mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject }))
    let pending!: Promise<void>
    await act(async () => { pending = input('Team name').props.onSubmitEditing() })
    mocks.userId = 'next-user'
    await act(async () => screen.update(React.createElement(ProfileScreen)))
    await act(async () => { fail(new Error('Old save failed')); await pending })
    expect(mocks.retryProfile).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.alert).not.toHaveBeenCalled()
})


it('keeps editing busy when the profile resource updates before the team save settles', async () => {
    let finish!: () => void
    mocks.updateTeamName.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    mocks.updateProfile.mockImplementationOnce(async () => {
        mocks.profile = { ...mocks.profile, display_name: 'Committed name' }
        mocks.receiveProfile?.(mocks.profile)
    })
    await act(async () => { input('Display name').props.onChangeText('Committed name'); input('Team name').props.onChangeText('New team') })
    let pending!: Promise<void>
    await act(async () => { pending = input('Team name').props.onSubmitEditing() })
    try {
        expect(button('Save')).toBeDefined()
        expect(button('Save').props.loading).toBe(true)
        expect(mocks.success).not.toHaveBeenCalled()
    } finally {
        await act(async () => { finish(); await pending })
    }
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(button('Edit')).toBeDefined()
})


it('reserves both identity lines and leaves unknown account values blank', async () => {
    await act(async () => mocks.receiveProfile?.({ display_name: '', username: '', avatar_url: null }))
    const names = screen.root.findAllByType('Text' as React.ElementType)
        .filter(node => Array.isArray(node.props.style) && node.props.style.some((style: { minHeight?: number }) => style?.minHeight))
    expect(names).toHaveLength(2)
    expect(names.every(node => node.props.style.some((style: { minHeight?: number }) => (style?.minHeight ?? 0) > 0))).toBe(true)
    const nameRow = screen.root.findAllByType('SettingsRow' as React.ElementType).find(node => node.props.label === 'Name')
    await act(async () => button('Cancel').props.onPress())
    expect(nameRow).toBeDefined()
    const accountRows = screen.root.findAllByType('SettingsRow' as React.ElementType).filter(node => ['Name', 'Email'].includes(node.props.label))
    expect(accountRows.every(node => node.props.value === '')).toBe(true)
})


it('leaves an unknown team name blank until the membership supplies it', async () => {
    mocks.teamName = null as unknown as string
    await act(async () => screen.update(React.createElement(ProfileScreen)))
    await act(async () => button('Cancel').props.onPress())
    const row = screen.root.findAllByType('SettingsRow' as React.ElementType).find(node => node.props.label === 'Team name')
    expect(row?.props.value).toBe('')
})

it('saves a display-name change without rewriting the unchanged team name', async () => {
    await act(async () => input('Display name').props.onChangeText('New Manager'))
    await act(async () => input('Team name').props.onChangeText('  Team  '))
    await act(async () => button('Save').props.onPress())
    expect(mocks.updateProfile).toHaveBeenCalledWith('user', { display_name: 'New Manager' })
    expect(mocks.updateTeamName).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
})

it('saves a changed team name once', async () => {
    await act(async () => input('Team name').props.onChangeText('  New Team  '))
    await act(async () => button('Save').props.onPress())
    expect(mocks.updateTeamName).toHaveBeenCalledExactlyOnceWith('member', 'New Team')
    expect(mocks.refresh).toHaveBeenCalledOnce()
})


it('limits team names to the server maximum while editing', () => {
    expect(input('Team name').props.maxLength).toBe(40)
})
