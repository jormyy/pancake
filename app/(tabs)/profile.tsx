import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '@/hooks/use-auth'
import { getProfile, updateProfile, signOut } from '@/lib/auth'
import { updateTeamName } from '@/lib/league'
import { getNotificationPreferences, updateNotificationPreferences, type NotificationPreferences } from '@/lib/notification-preferences'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import type { Profile } from '@/types/database'

export default function ProfileScreen() {
    const { user } = useAuth()
    const router = useRouter()
    const { current, currentLeague, refresh } = useLeagueContext()
    // On narrow screens stack value under label (left-aligned) so long
    // emails/usernames read on their own line instead of right-aligned wraps.
    const narrow = useWindowDimensions().width < 480
    const rowStyle = [styles.row, narrow && styles.rowNarrow]
    const valueStyle = [styles.rowValue, narrow && styles.rowValueNarrow]
    const [profile, setProfile] = useState<Profile | null>(null)
    const [editing, setEditing] = useState(false)
    const [displayName, setDisplayName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [saving, setSaving] = useState(false)
    const [preferences, setPreferences] = useState<NotificationPreferences>({
        tradeEnabled: true,
        waiverEnabled: true,
        draftEnabled: true,
        activityEnabled: true,
    })

    useEffect(() => {
        async function load() {
            if (!user) return
            try {
                const p = await getProfile(user.id)
                const prefs = await getNotificationPreferences(user.id)
                setProfile(p)
                setPreferences(prefs)
                setDisplayName(p.display_name ?? '')
            } catch (e) {
                console.error(e)
            }
        }
        load()
    }, [user])

    // Sync team name from context whenever it changes
    useEffect(() => {
        setTeamName(current?.team_name ?? '')
    }, [current?.team_name])

    async function handleSave() {
        if (!user) return
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
            setProfile((prev) => prev ? { ...prev, display_name: trimmedDisplay } : prev)
            setEditing(false)
            if (current && trimmedTeam !== current.team_name) {
                refresh()
            }
            showAlert('Saved', 'Your profile has been updated.')
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setSaving(false)
        }
    }

    function handleCancel() {
        setDisplayName(profile?.display_name ?? '')
        setTeamName(current?.team_name ?? '')
        setEditing(false)
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
        if (!user) return
        const next = { ...preferences, [key]: !preferences[key] }
        setPreferences(next)
        try {
            await updateNotificationPreferences(user.id, next)
        } catch (e) {
            setPreferences(preferences)
            showAlert('Error', getErrorMessage(e))
        }
    }

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {/* Avatar */}
                <View style={styles.avatarSection}>
                    <Avatar
                        name={profile?.display_name ?? profile?.username ?? '?'}
                        size={84}
                    />
                </View>

                {/* Info card */}
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
                {current && (
                    <>
                        <Text style={styles.sectionLabel}>
                            {currentLeague?.name?.toUpperCase() ?? 'LEAGUE'}
                        </Text>
                        <View style={styles.card}>
                            <View style={rowStyle}>
                                <Text style={styles.rowLabel}>Team Name</Text>
                                {editing ? (
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

                <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
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
                                    role="switch"
                                    aria-checked={enabled}
                                    accessibilityRole="switch"
                                    accessibilityState={{ checked: enabled }}
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

                {/* Edit / Save / Cancel buttons */}
                {editing ? (
                    <View style={styles.actionRow}>
                        <Button title="Cancel" variant="secondary" onPress={handleCancel} style={styles.flexBtn} />
                        <Button title="Save" onPress={handleSave} loading={saving} style={styles.flexBtn} />
                    </View>
                ) : (
                    <Button title="Edit Profile" variant="outline" fullWidth icon="edit" onPress={() => setEditing(true)} />
                )}

                {/* Account actions */}
                {!editing ? (
                    <Button
                        title="Change Password"
                        variant="outline"
                        fullWidth
                        icon="lock"
                        onPress={() => router.push('/(modals)/change-password')}
                    />
                ) : null}

                {/* Sign out */}
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
    // Settings read best as a narrow column: cap well below the app-wide
    // content width so label → value eye travel stays short on desktop.
    scrollContent: { padding: spacing['3xl'], gap: spacing.xl, width: '100%', maxWidth: 720, alignSelf: 'center' },

    avatarSection: { alignItems: 'center', paddingTop: 48, paddingBottom: spacing.md },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0.8,
        marginTop: spacing.md,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgCard,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
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
    rowLabel: { width: 80, fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.medium },
    // Switch rows always fit on one line, so the label takes the free space
    // and the toggle right-aligns like the info-row values above it.
    switchLabel: { width: 'auto', flex: 1 },
    rowValue: { flex: 1, minWidth: 0, fontSize: 15, color: colors.textPrimary, fontWeight: fontWeight.medium, textAlign: 'right' },
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
        backgroundColor: colors.bgMuted,
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
