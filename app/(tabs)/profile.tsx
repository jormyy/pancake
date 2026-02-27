import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { getProfile, updateProfile, signOut } from '@/lib/auth'

export default function ProfileScreen() {
    const { user } = useAuth()
    const [profile, setProfile] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState(false)
    const [displayName, setDisplayName] = useState('')
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

    async function handleSave() {
        if (!user) return
        const trimmed = displayName.trim()
        if (!trimmed) {
            Alert.alert('Invalid', 'Display name cannot be empty.')
            return
        }
        setSaving(true)
        try {
            await updateProfile(user.id, { display_name: trimmed })
            setProfile((prev: any) => ({ ...prev, display_name: trimmed }))
            setEditing(false)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    function handleCancel() {
        setDisplayName(profile?.display_name ?? '')
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

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
    }

    const initials = (profile?.display_name ?? profile?.username ?? '?')
        .split(' ')
        .map((w: string) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.scroll}>
                {/* Avatar */}
                <View style={styles.avatarSection}>
                    <View style={styles.avatar}>
                        <Text style={styles.avatarText}>{initials}</Text>
                    </View>
                </View>

                {/* Info card */}
                <View style={styles.card}>
                    {/* Display name */}
                    <View style={styles.row}>
                        <Text style={styles.rowLabel}>Name</Text>
                        {editing ? (
                            <TextInput
                                style={styles.input}
                                value={displayName}
                                onChangeText={setDisplayName}
                                autoFocus
                                returnKeyType="done"
                                onSubmitEditing={handleSave}
                            />
                        ) : (
                            <Text style={styles.rowValue}>{profile?.display_name ?? '—'}</Text>
                        )}
                    </View>

                    <View style={styles.divider} />

                    {/* Username */}
                    <View style={styles.row}>
                        <Text style={styles.rowLabel}>Username</Text>
                        <Text style={styles.rowValue}>@{profile?.username}</Text>
                    </View>

                    <View style={styles.divider} />

                    {/* Email */}
                    <View style={styles.row}>
                        <Text style={styles.rowLabel}>Email</Text>
                        <Text style={styles.rowValue}>{user?.email}</Text>
                    </View>
                </View>

                {/* Edit / Save / Cancel buttons */}
                {editing ? (
                    <View style={styles.actionRow}>
                        <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                            <Text style={styles.cancelButtonText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.saveButton}
                            onPress={handleSave}
                            disabled={saving}
                        >
                            {saving ? (
                                <ActivityIndicator size="small" color="#fff" />
                            ) : (
                                <Text style={styles.saveButtonText}>Save</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                ) : (
                    <TouchableOpacity style={styles.editButton} onPress={() => setEditing(true)}>
                        <Text style={styles.editButtonText}>Edit Profile</Text>
                    </TouchableOpacity>
                )}

                {/* Sign out */}
                <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                    <Text style={styles.signOutText}>Sign Out</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    scroll: { flex: 1, padding: 24, gap: 16 },

    avatarSection: { alignItems: 'center', paddingVertical: 8 },
    avatar: {
        width: 84,
        height: 84,
        borderRadius: 42,
        backgroundColor: '#F97316',
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarText: { color: '#fff', fontSize: 30, fontWeight: '800' },

    card: {
        backgroundColor: '#fff',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#eee',
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    divider: { height: 1, backgroundColor: '#f3f3f3', marginLeft: 16 },
    rowLabel: { width: 80, fontSize: 14, color: '#aaa', fontWeight: '500' },
    rowValue: { flex: 1, fontSize: 15, color: '#111', fontWeight: '500' },
    input: {
        flex: 1,
        fontSize: 15,
        color: '#111',
        fontWeight: '500',
        borderBottomWidth: 1.5,
        borderBottomColor: '#F97316',
        padding: 0,
    },

    actionRow: { flexDirection: 'row', gap: 12 },
    editButton: {
        backgroundColor: '#fff',
        borderRadius: 12,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#ddd',
    },
    editButtonText: { fontSize: 15, fontWeight: '600', color: '#555' },

    saveButton: {
        flex: 1,
        backgroundColor: '#F97316',
        borderRadius: 12,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    cancelButton: {
        flex: 1,
        backgroundColor: '#fff',
        borderRadius: 12,
        height: 48,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#ddd',
    },
    cancelButtonText: { fontSize: 15, fontWeight: '600', color: '#555' },

    signOutButton: {
        marginTop: 8,
        height: 48,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#FCA5A5',
    },
    signOutText: { fontSize: 15, fontWeight: '600', color: '#EF4444' },
})
