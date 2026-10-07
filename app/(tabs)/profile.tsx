import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
    Platform,
    ActivityIndicator,
} from 'react-native'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useAuth } from '@/hooks/use-auth'
import { updateProfile, uploadAvatar, signOut } from '@/lib/auth'
import { updateTeamName } from '@/lib/league'
import {
    createNotificationPreferenceWriter,
    updateNotificationPreferences,
    type NotificationPreferences,
} from '@/lib/notification-preferences'
import { useProfileResource } from '@/hooks/use-profile-resource'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, radii, spacing, textStyles } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { WebPushSettings } from '@/components/WebPushSettings'
import { SettingsGroup, SettingsRow, SettingsToggle } from '@/components/settings/SettingsGroup'
import { Button, ErrorBanner, Page, usePageMetrics } from '@/components/ui'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import type { WebPushStatus } from '@/lib/web-push'

export default function ProfileScreen() {
    const { user } = useAuth()
    const router = useRouter()
    const { current, currentLeague, refresh, loading: leagueLoading } = useLeagueContext()
    const { padX } = usePageMetrics()
    const [editing, setEditing] = useState(false)
    const [displayName, setDisplayName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [saving, setSaving] = useState(false)
    const [avatarUploading, setAvatarUploading] = useState(false)
    const [webPushStatus, setWebPushStatus] = useState<WebPushStatus | null>(null)
    const showPreferenceToggles = Platform.OS !== 'web' || webPushStatus === 'on'
    const preferenceUserId = user?.id
    const activeUserIdRef = useRef(preferenceUserId)
    activeUserIdRef.current = preferenceUserId
    const { profile, profileLoaded, profileError, preferences, retryProfile, setProfile, setPreferences } =
        useProfileResource(preferenceUserId)
    const preferencesRef = useRef(preferences)
    preferencesRef.current = preferences
    const preferenceSessionRef = useRef({
        ownerId: preferenceUserId,
        writer: createNotificationPreferenceWriter(
            preferenceUserId ? (next) => updateNotificationPreferences(preferenceUserId, next) : async () => undefined,
        ),
    })
    if (preferenceSessionRef.current.ownerId !== preferenceUserId) {
        preferenceSessionRef.current = {
            ownerId: preferenceUserId,
            writer: createNotificationPreferenceWriter(
                preferenceUserId ? (next) => updateNotificationPreferences(preferenceUserId, next) : async () => undefined,
            ),
        }
    }

    useEffect(() => {
        setEditing(false)
        setDisplayName(profileLoaded ? profile?.display_name ?? '' : '')
    }, [preferenceUserId, profile?.display_name, profileLoaded])

    // Sync team name from context whenever it changes
    useEffect(() => {
        setTeamName(current?.team_name ?? '')
    }, [current?.team_name])

    async function handleSave() {
        if (!user) return
        const ownerId = user.id
        const trimmedDisplay = displayName.trim()
        const trimmedTeam = teamName.trim()
        if (!trimmedDisplay) {
            showAlert('Invalid', 'Display name cannot be empty.')
            return
        }
        setSaving(true)
        try {
            const saves: Promise<void>[] = [
                updateProfile(user.id, { display_name: trimmedDisplay }),
            ]
            if (current && trimmedTeam) {
                saves.push(updateTeamName(current.id, trimmedTeam))
            }
            await Promise.all(saves)
            if (activeUserIdRef.current !== ownerId) return
            setProfile((prev) => prev ? { ...prev, display_name: trimmedDisplay } : prev)
            setEditing(false)
            if (current && trimmedTeam !== current.team_name) {
                refresh()
            }
            showAlert('Saved', 'Your profile has been updated.')
        } catch (e) {
            if (activeUserIdRef.current === ownerId) showAlert('Error', getErrorMessage(e))
        } finally {
            if (activeUserIdRef.current === ownerId) setSaving(false)
        }
    }

    function handleCancel() {
        setDisplayName(profile?.display_name ?? '')
        setTeamName(current?.team_name ?? '')
        setEditing(false)
    }

    async function handlePickAvatar() {
        if (!user) return
        const ownerId = user.id
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync()
        if (status !== 'granted') {
            showAlert('Permission Required', 'Allow photo library access to change your profile picture.')
            return
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: 'images',
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        })
        if (result.canceled) return
        const asset = result.assets[0]
        setAvatarUploading(true)
        try {
            const url = await uploadAvatar(ownerId, asset)
            if (activeUserIdRef.current !== ownerId) return
            setProfile((prev) => prev ? { ...prev, avatar_url: url } : prev)
        } catch (e) {
            if (activeUserIdRef.current === ownerId) showAlert('Error', getErrorMessage(e))
        } finally {
            if (activeUserIdRef.current === ownerId) setAvatarUploading(false)
        }
    }

    function handleSignOut() {
        confirmAction('Sign Out', 'Are you sure you want to sign out?', async () => {
            try {
                await signOut()
            } catch (e) {
                console.error(e)
                showAlert('Error', 'Sign out failed. Please try again.')
            }
        }, 'Sign Out')
    }

    async function togglePreference(key: keyof NotificationPreferences) {
        if (!user || !profileLoaded) return
        const session = preferenceSessionRef.current
        const previous = preferencesRef.current
        const next = { ...previous, [key]: !previous[key] }
        preferencesRef.current = next
        setPreferences(next)
        const task = session.writer.enqueue(next)
        try {
            await task
        } catch (e) {
            if (preferenceSessionRef.current === session && preferencesRef.current === next) {
                preferencesRef.current = previous
                setPreferences(previous)
            }
            if (preferenceSessionRef.current === session) showAlert('Error', getErrorMessage(e))
        }
    }
    const showTeamSection = Boolean(current) || leagueLoading

    const notificationRows: [keyof NotificationPreferences, string][] = [
        ['tradeEnabled', 'Trades'],
        ['waiverEnabled', 'Waivers'],
        ['draftEnabled', 'Drafts'],
        ['activityEnabled', 'League activity'],
    ]

    return (
        <Page title="Profile" width="form">
            {profileError ? (
                <ErrorBanner
                    message={`${profileError} Tap to retry.`}
                    onRetry={() => { void retryProfile() }}
                />
            ) : null}
            <ScrollView style={styles.scroll} contentContainerStyle={[styles.scrollContent, { paddingHorizontal: padX }]}>
                <View style={styles.identity}>
                    <Pressable
                        onPress={handlePickAvatar}
                        disabled={avatarUploading || !profileLoaded}
                        style={styles.avatarWrapper}
                        accessibilityRole="button"
                        accessibilityLabel="Change profile photo"
                        accessibilityState={{ disabled: avatarUploading || !profileLoaded, busy: avatarUploading }}
                    >
                        <Avatar
                            name={profile?.display_name ?? profile?.username ?? '?'}
                            size={64}
                            uri={profile?.avatar_url}
                        />
                        <View style={styles.avatarBadge}>
                            {avatarUploading
                                ? <ActivityIndicator size={12} color={colors.textWhite} />
                                : <MaterialIcons name="photo-camera" size={12} color={colors.textWhite} />
                            }
                        </View>
                    </Pressable>
                    <View style={styles.identityText}>
                        <Text style={textStyles.pageTitle} numberOfLines={1}>
                            {profile?.display_name ?? 'Profile'}
                        </Text>
                        {profile?.username ? <Text style={textStyles.meta} numberOfLines={1}>@{profile.username}</Text> : null}
                    </View>
                    {editing ? (
                        <View style={styles.identityActions}>
                            <Button title="Cancel" variant="ghost" size="sm" onPress={handleCancel} />
                            <Button title="Save" size="sm" onPress={handleSave} loading={saving} />
                        </View>
                    ) : (
                        <Button title="Edit" variant="outline" size="sm" icon="edit" disabled={!profileLoaded || !user} onPress={() => setEditing(true)} />
                    )}
                </View>

                <SettingsGroup title="Account">
                    <SettingsRow
                        label="Name"
                        value={editing ? null : profile?.display_name ?? '—'}
                        accessory={editing ? (
                            <TextInput
                                style={styles.input}
                                value={displayName}
                                onChangeText={setDisplayName}
                                autoFocus
                                returnKeyType="next"
                                accessibilityLabel="Display name"
                            />
                        ) : undefined}
                    />
                    <SettingsRow label="Email" value={user?.email ?? '—'} />
                </SettingsGroup>

                {showTeamSection ? (
                    <SettingsGroup title={currentLeague?.name ?? 'League'}>
                        <SettingsRow
                            label="Team name"
                            value={editing && current ? null : current?.team_name ?? '—'}
                            accessory={editing && current ? (
                                <TextInput
                                    style={styles.input}
                                    value={teamName}
                                    onChangeText={setTeamName}
                                    returnKeyType="done"
                                    onSubmitEditing={handleSave}
                                    placeholder="Your team name"
                                    placeholderTextColor={colors.inputPlaceholder}
                                    accessibilityLabel="Team name"
                                />
                            ) : undefined}
                        />
                    </SettingsGroup>
                ) : null}

                <SettingsGroup title="Notifications">
                    {/* Web delivers through standards Web Push; the category toggles only
                        matter once this device is subscribed. */}
                    {Platform.OS === 'web' ? <WebPushSettings onStatusChange={setWebPushStatus} /> : null}
                    {showPreferenceToggles ? notificationRows.map(([key, label]) => (
                        <SettingsRow
                            key={key}
                            label={label}
                            role="switch"
                            checked={preferences[key]}
                            disabled={!profileLoaded}
                            onPress={() => togglePreference(key)}
                            accessory={<SettingsToggle on={preferences[key]} />}
                        />
                    )) : null}
                </SettingsGroup>

                <SettingsGroup title="Leagues">
                    <SettingsRow label="Create a league" onPress={() => router.push('/(modals)/create-league')} />
                    <SettingsRow label="Join a league" onPress={() => router.push('/(modals)/join-league')} />
                </SettingsGroup>

                <SettingsGroup>
                    <SettingsRow label="Change password" onPress={() => router.push('/(modals)/change-password')} />
                    <SettingsRow label="Sign out" tone="danger" chevron={false} onPress={handleSignOut} />
                </SettingsGroup>
            </ScrollView>
        </Page>
    )
}

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    scrollContent: { paddingTop: spacing.xl, paddingBottom: spacing['4xl'], gap: spacing.xl },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    identityText: { flex: 1, minWidth: 0, gap: spacing.xxs },
    identityActions: { flexDirection: 'row', gap: spacing.sm },
    avatarWrapper: { position: 'relative' },
    avatarBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 22,
        height: 22,
        borderRadius: radii.full,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: colors.bgScreen,
    },
    // 16px keeps iOS Safari from zooming the page when the field is focused.
    input: {
        flex: 1.4,
        minWidth: 0,
        fontSize: fontSize.lg,
        color: colors.textPrimary,
        textAlign: 'right',
        borderBottomWidth: 1.5,
        borderBottomColor: colors.primary,
        paddingVertical: spacing.xs,
    },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
