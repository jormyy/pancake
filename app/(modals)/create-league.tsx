import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    ActivityIndicator,
    Share,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { createLeague } from '@/lib/league'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export default function CreateLeagueScreen() {
    const { user } = useAuth()
    const { refresh } = useLeagueContext()
    const { back } = useRouter()
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
            await refresh()
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

                <Pressable style={styles.shareButton} onPress={handleShare}>
                    <Text style={styles.shareButtonText}>Share Invite Code</Text>
                </Pressable>

                <Pressable style={styles.doneButton} onPress={() => back()}>
                    <Text style={styles.doneButtonText}>Done</Text>
                </Pressable>
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
                    placeholderTextColor={colors.textPlaceholder}
                    value={leagueName}
                    onChangeText={setLeagueName}
                />

                <Text style={styles.label}>Your Team Name</Text>
                <TextInput
                    style={styles.input}
                    placeholder="e.g. Buckets FC"
                    placeholderTextColor={colors.textPlaceholder}
                    value={teamName}
                    onChangeText={setTeamName}
                />

                <Text style={styles.label}>Auction Budget per Team ($)</Text>
                <TextInput
                    style={styles.input}
                    placeholder="200"
                    placeholderTextColor={colors.textPlaceholder}
                    keyboardType="number-pad"
                    value={auctionBudget}
                    onChangeText={setAuctionBudget}
                />
                <Text style={styles.hint}>Default is $200. All managers get the same budget.</Text>

                {error && <Text style={styles.error}>{error}</Text>}

                <Pressable style={styles.button} onPress={handleCreate} disabled={loading}>
                    {loading ? (
                        <ActivityIndicator color={colors.textWhite} />
                    ) : (
                        <Text style={styles.buttonText}>Create League</Text>
                    )}
                </Pressable>
            </ScrollView>
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: { padding: spacing['3xl'], gap: spacing.md },
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
    hint: { fontSize: 12, color: colors.textPlaceholder },
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

    // Success state
    successContainer: {
        flex: 1,
        backgroundColor: colors.bgScreen,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['4xl'],
        gap: spacing.xl,
    },
    successTitle: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold },
    successSub: { fontSize: 15, color: colors.textMuted, textAlign: 'center' },
    codeBox: {
        backgroundColor: colors.primaryLight,
        borderWidth: 2,
        borderColor: colors.primary,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous' as const,
        paddingVertical: spacing['3xl'],
        paddingHorizontal: spacing['5xl'],
        marginVertical: spacing.md,
    },
    codeText: { fontSize: fontSize['5xl'], fontWeight: fontWeight.extrabold, color: colors.primary, letterSpacing: 8 },
    shareButton: {
        width: '100%',
        height: 52,
        backgroundColor: colors.primary,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    shareButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
    doneButton: {
        width: '100%',
        height: 52,
        borderWidth: 1.5,
        borderColor: colors.border,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    doneButtonText: { color: colors.textSecondary, fontWeight: fontWeight.semibold, fontSize: fontSize.lg },
})
