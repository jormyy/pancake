import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    ActivityIndicator,
    Share,
} from 'react-native'
import { router } from 'expo-router'
import { useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { createLeague } from '@/lib/league'

export default function CreateLeagueScreen() {
    const { user } = useAuth()
    const [leagueName, setLeagueName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [auctionBudget, setAuctionBudget] = useState('200')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [inviteCode, setInviteCode] = useState<string | null>(null)

    async function handleCreate() {
        if (!leagueName.trim() || !teamName.trim()) {
            setError('League name and team name are required.')
            return
        }
        const budget = parseInt(auctionBudget)
        if (isNaN(budget) || budget < 100) {
            setError('Auction budget must be at least $100.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            const league = await createLeague(user!.id, leagueName.trim(), teamName.trim(), budget)
            setInviteCode(league.invite_code)
        } catch (e: any) {
            setError(e.message ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    function handleShare() {
        Share.share({
            message: `Join my dynasty basketball league on Pancake! Invite code: ${inviteCode}`,
        })
    }

    // Success state — show invite code
    if (inviteCode) {
        return (
            <View style={styles.successContainer}>
                <Text style={styles.successTitle}>League Created!</Text>
                <Text style={styles.successSub}>Share this code with your managers</Text>

                <View style={styles.codeBox}>
                    <Text style={styles.codeText}>{inviteCode}</Text>
                </View>

                <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
                    <Text style={styles.shareButtonText}>Share Invite Code</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.doneButton} onPress={() => router.back()}>
                    <Text style={styles.doneButtonText}>Done</Text>
                </TouchableOpacity>
            </View>
        )
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
                <Text style={styles.label}>League Name</Text>
                <TextInput
                    style={styles.input}
                    placeholder="e.g. Hoops Dynasty"
                    placeholderTextColor="#aaa"
                    value={leagueName}
                    onChangeText={setLeagueName}
                />

                <Text style={styles.label}>Your Team Name</Text>
                <TextInput
                    style={styles.input}
                    placeholder="e.g. Buckets FC"
                    placeholderTextColor="#aaa"
                    value={teamName}
                    onChangeText={setTeamName}
                />

                <Text style={styles.label}>Auction Budget per Team ($)</Text>
                <TextInput
                    style={styles.input}
                    placeholder="200"
                    placeholderTextColor="#aaa"
                    keyboardType="number-pad"
                    value={auctionBudget}
                    onChangeText={setAuctionBudget}
                />
                <Text style={styles.hint}>Default is $200. All managers get the same budget.</Text>

                {error && <Text style={styles.error}>{error}</Text>}

                <TouchableOpacity style={styles.button} onPress={handleCreate} disabled={loading}>
                    {loading ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <Text style={styles.buttonText}>Create League</Text>
                    )}
                </TouchableOpacity>
            </ScrollView>
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    inner: { padding: 24, gap: 8 },
    label: { fontSize: 14, fontWeight: '600', color: '#333', marginTop: 12 },
    input: {
        height: 50,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        paddingHorizontal: 16,
        fontSize: 16,
        backgroundColor: '#fafafa',
    },
    hint: { fontSize: 12, color: '#aaa' },
    error: { color: '#d00', fontSize: 14, marginTop: 8 },
    button: {
        height: 50,
        backgroundColor: '#F97316',
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 24,
    },
    buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },

    // Success state
    successContainer: {
        flex: 1,
        backgroundColor: '#fff',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
        gap: 16,
    },
    successTitle: { fontSize: 28, fontWeight: '800' },
    successSub: { fontSize: 15, color: '#888', textAlign: 'center' },
    codeBox: {
        backgroundColor: '#FFF7ED',
        borderWidth: 2,
        borderColor: '#F97316',
        borderRadius: 16,
        paddingVertical: 24,
        paddingHorizontal: 40,
        marginVertical: 8,
    },
    codeText: { fontSize: 36, fontWeight: '800', color: '#F97316', letterSpacing: 8 },
    shareButton: {
        width: '100%',
        height: 52,
        backgroundColor: '#F97316',
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    shareButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
    doneButton: {
        width: '100%',
        height: 52,
        borderWidth: 1.5,
        borderColor: '#ddd',
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    doneButtonText: { color: '#555', fontWeight: '600', fontSize: 16 },
})
