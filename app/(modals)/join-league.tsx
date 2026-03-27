import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { joinLeague } from '@/lib/league'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export default function JoinLeagueScreen() {
    const { user } = useAuth()
    const { back } = useRouter()
    const [inviteCode, setInviteCode] = useState('')
    const [teamName, setTeamName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleJoin() {
        if (!inviteCode.trim() || !teamName.trim()) {
            setError('Invite code and team name are required.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await joinLeague(inviteCode.trim(), user!.id, teamName.trim())
            back()
        } catch (e: any) {
            setError(e.message ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={styles.inner}>
                <Text style={styles.label}>Invite Code</Text>
                <TextInput
                    style={[styles.input, styles.codeInput]}
                    placeholder="XXXXXX"
                    placeholderTextColor={colors.textPlaceholder}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    value={inviteCode}
                    onChangeText={(t) => setInviteCode(t.toUpperCase())}
                />

                <Text style={styles.label}>Your Team Name</Text>
                <TextInput
                    style={styles.input}
                    placeholder="e.g. Buckets FC"
                    placeholderTextColor={colors.textPlaceholder}
                    value={teamName}
                    onChangeText={setTeamName}
                />

                {error && <Text style={styles.error}>{error}</Text>}

                <Pressable style={styles.button} onPress={handleJoin} disabled={loading}>
                    {loading ? (
                        <ActivityIndicator color={colors.textWhite} />
                    ) : (
                        <Text style={styles.buttonText}>Join League</Text>
                    )}
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: { flex: 1, padding: spacing['3xl'], gap: spacing.md },
    label: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textSecondary, marginTop: spacing.lg },
    input: {
        height: 50,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.xl,
        fontSize: fontSize.lg,
        backgroundColor: colors.bgInput,
    },
    codeInput: {
        fontSize: 22,
        fontWeight: fontWeight.bold,
        letterSpacing: 6,
        textAlign: 'center',
    },
    error: { color: palette.redBright, fontSize: fontSize.md, marginTop: spacing.md },
    button: {
        height: 50,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: spacing['3xl'],
    },
    buttonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
