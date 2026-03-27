import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { getProfile, updateProfile, signOut } from '@/lib/auth'
import { updateTeamName } from '@/lib/league'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { Avatar } from '@/components/Avatar'

export default function ProfileScreen() {
    const { user } = useAuth()
    const { current, refresh } = useLeagueContext()
    const [profile, setProfile] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState(false)
    const [displayName, setDisplayName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        async function load() {
            if (!user) return
            try {
                const p = await getProfile(user.id)
                setProfile(p)
                setDisplayName(p.display_name ?? '')
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [user])

    // Sync team name from context whenever it changes
    useEffect(() => {
        setTeamName((current as any)?.team_name ?? '')
    }, [(current as any)?.team_name])

    async function handleSave() {
        if (!user) return
        const trimmedDisplay = displayName.trim()
        const trimmedTeam = teamName.trim()
        if (!trimmedDisplay) {
            Alert.alert('Invalid', 'Display name cannot be empty.')
            return
        }
        setSaving(true)
        try {
            const saves: Promise<any>[] = [
                updateProfile(user.id, { display_name: trimmedDisplay }),
            ]
            if (current && trimmedTeam) {
                saves.push(updateTeamName((current as any).id, trimmedTeam))
            }
            await Promise.all(saves)
            setProfile((prev: any) => ({ ...prev, display_name: trimmedDisplay }))
            setEditing(false)
            refresh()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    function handleCancel() {
        setDisplayName(profile?.display_name ?? '')
        setTeamName((current as any)?.team_name ?? '')
        setEditing(false)
    }

    async function handleSignOut() {
        Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Sign Out',
                style: 'destructive',
                onPress: async () => {
                    try {
                        await signOut()
                    } catch (e) {
                        console.error(e)
                    }
                },
            },
        ])
    }

    if (loading) return <LoadingScreen />

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.scroll}>
                {/* Avatar */}
                <View style={styles.avatarSection}>
                    <Avatar
                        name={profile?.display_name ?? profile?.username ?? '?'}
                        size={84}
                    />
                </View>

                {/* Info card */}
                <View style={styles.card}>
                    <View style={styles.row}>
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
                            <Text style={styles.rowValue}>{profile?.display_name ?? '—'}</Text>
                        )}
                    </View>

                    <View style={styles.divider} />

                    <View style={styles.row}>
                        <Text style={styles.rowLabel}>Username</Text>
                        <Text style={styles.rowValue}>@{profile?.username}</Text>
                    </View>

                    <View style={styles.divider} />

                    <View style={styles.row}>
                        <Text style={styles.rowLabel}>Email</Text>
                        <Text style={styles.rowValue}>{user?.email}</Text>
                    </View>
                </View>

                {/* Team name (league-specific) */}
                {current && (
                    <>
                        <Text style={styles.sectionLabel}>
                            {(current as any).leagues?.name?.toUpperCase() ?? 'LEAGUE'}
                        </Text>
                        <View style={styles.card}>
                            <View style={styles.row}>
                                <Text style={styles.rowLabel}>Team Name</Text>
                                {editing ? (
                                    <TextInput
                                        style={styles.input}
                                        value={teamName}
                                        onChangeText={setTeamName}
                                        returnKeyType="done"
                                        onSubmitEditing={handleSave}
                                        placeholder="Your team name"
                                        placeholderTextColor={palette.gray500}
                                    />
                                ) : (
                                    <Text style={styles.rowValue}>
                                        {(current as any).team_name ?? '—'}
                                    </Text>
                                )}
                            </View>
                        </View>
                    </>
                )}

                {/* Edit / Save / Cancel buttons */}
                {editing ? (
                    <View style={styles.actionRow}>
                        <Pressable style={styles.cancelButton} onPress={handleCancel}>
                            <Text style={styles.cancelButtonText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            style={styles.saveButton}
                            onPress={handleSave}
                            disabled={saving}
                        >
                            {saving ? (
                                <ActivityIndicator size="small" color={colors.textWhite} />
                            ) : (
                                <Text style={styles.saveButtonText}>Save</Text>
                            )}
                        </Pressable>
                    </View>
                ) : (
                    <Pressable style={styles.editButton} onPress={() => setEditing(true)}>
                        <Text style={styles.editButtonText}>Edit Profile</Text>
                    </Pressable>
                )}

                {/* Sign out */}
                <Pressable style={styles.signOutButton} onPress={handleSignOut}>
                    <Text style={styles.signOutText}>Sign Out</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    scroll: { flex: 1, padding: spacing['3xl'], gap: spacing.xl },

    avatarSection: { alignItems: 'center', paddingVertical: spacing.md },

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
    rowLabel: { width: 80, fontSize: fontSize.md, color: colors.textPlaceholder, fontWeight: fontWeight.medium },
    rowValue: { flex: 1, fontSize: 15, color: colors.textPrimary, fontWeight: fontWeight.medium },
    input: {
        flex: 1,
        fontSize: 15,
        color: colors.textPrimary,
        fontWeight: fontWeight.medium,
        borderBottomWidth: 1.5,
        borderBottomColor: colors.primary,
        padding: 0,
    },

    actionRow: { flexDirection: 'row', gap: spacing.lg },
    editButton: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.border,
    },
    editButtonText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    saveButton: {
        flex: 1,
        backgroundColor: colors.primary,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    cancelButton: {
        flex: 1,
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.border,
    },
    cancelButtonText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    signOutButton: {
        marginTop: spacing.md,
        height: 48,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#FCA5A5',
    },
    signOutText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.danger },
})
