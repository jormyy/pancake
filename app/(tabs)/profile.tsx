import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
    Platform,
    useWindowDimensions,
    ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
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
import { colors, fontFamily, fontSize, fontWeight, radii, shadows, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Button, ErrorBanner } from '@/components/ui'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

export default function ProfileScreen() {
    const { user } = useAuth()
    const router = useRouter()
    const { current, currentLeague, refresh, loading: leagueLoading } = useLeagueContext()
    // On narrow screens stack value under label (left-aligned) so long
    // emails/usernames read on their own line instead of right-aligned wraps.
    const narrow = useWindowDimensions().width < 480
    const rowStyle = [styles.row, narrow && styles.rowNarrow]
    const valueStyle = [styles.rowValue, narrow && styles.rowValueNarrow]
    const [editing, setEditing] = useState(false)
    const [displayName, setDisplayName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [saving, setSaving] = useState(false)
    const [avatarUploading, setAvatarUploading] = useState(false)
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

    return (
        <SafeAreaView style={styles.container}>
            {profileError ? (
                <ErrorBanner
                    message={`${profileError} Tap to retry.`}
                    onRetry={() => { void retryProfile() }}
                />
            ) : null}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                <View style={styles.avatarSection}>
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
                            size={84}
                            uri={profile?.avatar_url}
                        />
                        <View style={styles.avatarBadge}>
                            {avatarUploading
                                ? <ActivityIndicator size={12} color={colors.textWhite} />
                                : <MaterialIcons name="photo-camera" size={14} color={colors.textWhite} />
                            }
                        </View>
                    </Pressable>
                    <Text style={styles.profileTitle} numberOfLines={1}>
                        {profile?.display_name ?? 'Profile'}
                    </Text>
                    <Text style={styles.profileSubtitle}>Profile & settings</Text>
                </View>

                <View style={styles.card}>
                    <View style={rowStyle}>
                        <Text style={styles.rowLabel}>Name</Text>
                        {editing ? (
                            <TextInput
                                style={styles.input}
                                value={displayName}
                                onChangeText={setDisplayName}
                                autoFocus
                                returnKeyType="next"
                            />
                        ) : (
                            <Text style={valueStyle}>{profile?.display_name ?? '—'}</Text>
                        )}
                    </View>

                    <View style={styles.divider} />

                    <View style={rowStyle}>
                        <Text style={styles.rowLabel}>Username</Text>
                        <Text style={valueStyle} numberOfLines={narrow ? 2 : 1}>@{profile?.username}</Text>
                    </View>

                    <View style={styles.divider} />

                    <View style={rowStyle}>
                        <Text style={styles.rowLabel}>Email</Text>
                        <Text style={valueStyle} numberOfLines={narrow ? 2 : 1}>{user?.email}</Text>
                    </View>
                </View>

                {/* Team name (league-specific) */}
                {showTeamSection && (
                    <>
                        <Text style={styles.sectionLabel}>
                            {currentLeague?.name ?? 'League'}
                        </Text>
                        <View style={styles.card}>
                            <View style={rowStyle}>
                                <Text style={styles.rowLabel}>Team Name</Text>
                                {editing && current ? (
                                    <TextInput
                                        style={styles.input}
                                        value={teamName}
                                        onChangeText={setTeamName}
                                        returnKeyType="done"
                                        onSubmitEditing={handleSave}
                                        placeholder="Your team name"
                                        placeholderTextColor={colors.textPlaceholder}
                                    />
                                ) : (
                                    <Text style={valueStyle}>
                                        {current?.team_name ?? '—'}
                                    </Text>
                                )}
                            </View>
                        </View>
                    </>
                )}

                <Text style={styles.sectionLabel}>Leagues</Text>
                <View style={styles.actionRow}>
                    <Button
                        title="Create League"
                        variant="outline"
                        icon="add"
                        onPress={() => router.push('/(modals)/create-league')}
                        style={styles.flexBtn}
                    />
                    <Button
                        title="Join League"
                        variant="outline"
                        icon="vpn-key"
                        onPress={() => router.push('/(modals)/join-league')}
                        style={styles.flexBtn}
                    />
                </View>

                {/* Web has no push transport, so these toggles could never deliver. */}
                {Platform.OS !== 'web' ? (
                    <>
                        <Text style={styles.sectionLabel}>Notifications</Text>
                        <View style={styles.card}>
                            {([
                                ['tradeEnabled', 'Trades'],
                                ['waiverEnabled', 'Waivers'],
                                ['draftEnabled', 'Drafts'],
                                ['activityEnabled', 'League Activity'],
                            ] as [keyof NotificationPreferences, string][]).map(([key, label], index, all) => {
                                const enabled = preferences[key]
                                return (
                                    <View key={key}>
                                        <Pressable
                                            style={styles.row}
                                            onPress={() => togglePreference(key)}
                                            disabled={!profileLoaded}
                                            role="switch"
                                            aria-checked={enabled}
                                            accessibilityRole="switch"
                                            accessibilityState={{ checked: enabled, disabled: !profileLoaded }}
                                        >
                                            <Text style={[styles.rowLabel, styles.switchLabel]}>{label}</Text>
                                            <View style={[styles.toggle, enabled && styles.toggleOn]}>
                                                <View style={[styles.toggleKnob, enabled && styles.toggleKnobOn]} />
                                            </View>
                                        </Pressable>
                                        {index < all.length - 1 ? <View style={styles.divider} /> : null}
                                    </View>
                                )
                            })}
                        </View>
                    </>
                ) : null}

                {editing ? (
                    <View style={styles.actionRow}>
                        <Button title="Cancel" variant="secondary" onPress={handleCancel} style={styles.flexBtn} />
                        <Button title="Save" onPress={handleSave} loading={saving} style={styles.flexBtn} />
                    </View>
                ) : (
                    <Button title="Edit Profile" variant="outline" fullWidth icon="edit" disabled={!profileLoaded || !user} onPress={() => setEditing(true)} />
                )}

                {!editing ? (
                    <Button
                        title="Change Password"
                        variant="outline"
                        fullWidth
                        icon="lock"
                        onPress={() => router.push('/(modals)/change-password')}
                    />
                ) : null}

                <Button title="Sign Out" variant="ghost" fullWidth icon="logout" onPress={handleSignOut} style={styles.signOutButton} />
                <View style={styles.appMeta}>
                    <Text style={styles.appMetaText}>Pancake · Dynasty Hoops</Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing['3xl'], gap: spacing.xl, width: '100%', maxWidth: 760, alignSelf: 'center' },

    avatarSection: {
        alignItems: 'center',
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.lg,
        gap: spacing.sm,
    },
    avatarWrapper: {
        position: 'relative',
    },
    avatarBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 26,
        height: 26,
        borderRadius: 13,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: colors.bgScreen,
    },
    profileTitle: {
        maxWidth: '100%',
        color: colors.textPrimary,
        fontSize: fontSize['2xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    profileSubtitle: {
        color: colors.textMuted,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
    },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.4,
        marginTop: spacing.md,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
        ...(Platform.OS === 'web' ? { boxShadow: shadows.sm } : {}),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
        gap: spacing.lg,
    },
    divider: { height: 1, backgroundColor: colors.separator, marginLeft: spacing.xl },
    rowNarrow: { flexDirection: 'column', alignItems: 'flex-start', gap: spacing.xs, paddingVertical: spacing.lg },
    rowLabel: { width: 86, fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    switchLabel: { width: 'auto', flex: 1 },
    rowValue: { flex: 1, minWidth: 0, fontSize: 15, color: colors.textPrimary, fontWeight: fontWeight.semibold, textAlign: 'right' },
    rowValueNarrow: { width: '100%', flexGrow: 0, flexShrink: 0, flexBasis: 'auto', textAlign: 'left' },
    input: {
        flex: 1,
        fontSize: 15,
        color: colors.textPrimary,
        fontWeight: fontWeight.medium,
        borderBottomWidth: 1.5,
        borderBottomColor: colors.primary,
        padding: 0,
    },
    toggle: {
        width: 48,
        height: 28,
        borderRadius: 14,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    toggleOn: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    toggleKnob: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: colors.bgCard,
    },
    toggleKnobOn: {
        alignSelf: 'flex-end',
    },

    actionRow: { flexDirection: 'row', gap: spacing.lg },
    flexBtn: { flex: 1 },
    signOutButton: { marginTop: spacing.md },
    appMeta: { alignItems: 'center', paddingTop: spacing.lg },
    appMetaText: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: fontWeight.semibold, letterSpacing: 0.5 },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
