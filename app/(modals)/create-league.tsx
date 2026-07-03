import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Share,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { createLeague } from '@/lib/league'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/alert'

export default function CreateLeagueScreen() {
    const { user } = useAuth()
    const { refresh } = useLeagueContext()
    const router = useRouter()
    const [leagueName, setLeagueName] = useState('')
    const [teamName, setTeamName] = useState('')
    const [auctionBudget, setAuctionBudget] = useState('200')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [inviteCode, setInviteCode] = useState<string | null>(null)
    const sharingRef = useRef(false)
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState({ width, height })
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])
    const viewportWidth = Platform.OS === 'web' ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' ? webViewport.height : height
    const isCompactLandscape = viewportWidth > viewportHeight && viewportHeight < 520

    async function handleCreate() {
        if (!leagueName.trim() || !teamName.trim()) {
            setError('League name and team name are required.')
            return
        }
        const budget = parseInt(auctionBudget, 10)
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
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    async function handleShare() {
        if (sharingRef.current) return
        sharingRef.current = true
        try {
            await Share.share({
                message: `Join my dynasty basketball league on Pancake! Invite code: ${inviteCode}`,
            })
        } finally {
            sharingRef.current = false
        }
    }

    function renderScreenHeader(title: string) {
        return (
            <View style={styles.screenHeader}>
                <Pressable
                    onPress={() => router.back()}
                    style={styles.headerBack}
                    role="link"
                    aria-label="Back"
                    accessibilityRole="link"
                    accessibilityLabel="Back"
                >
                    <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
                </Pressable>
                <Text style={styles.screenTitle} numberOfLines={1}>
                    {title}
                </Text>
            </View>
        )
    }

    // Success state — show invite code
    if (inviteCode) {
        const successContent = isCompactLandscape ? (
            <View style={[styles.successContainer, styles.compactSuccessContainer]}>
                <View style={styles.compactSuccessCopy}>
                    <Text style={styles.successTitle}>League Created!</Text>
                    <Text style={styles.successSub}>Share this code with your managers</Text>

                    <View style={styles.codeBox}>
                        <Text style={styles.codeText}>{inviteCode}</Text>
                    </View>
                </View>

                <View style={styles.compactSuccessActions}>
                    <Pressable
                        style={styles.shareButton}
                        onPress={handleShare}
                        accessibilityRole="button"
                        accessibilityLabel="Share invite code"
                    >
                        <Text style={styles.shareButtonText}>Share Invite Code</Text>
                    </Pressable>

                    <Pressable
                        style={styles.doneButton}
                        onPress={() => router.back()}
                        accessibilityRole="button"
                        accessibilityLabel="Done"
                    >
                        <Text style={styles.doneButtonText}>Done</Text>
                    </Pressable>
                </View>
            </View>
        ) : (
            <View style={styles.successContainer}>
                <Text style={styles.successTitle}>League Created!</Text>
                <Text style={styles.successSub}>Share this code with your managers</Text>

                <View style={styles.codeBox}>
                    <Text style={styles.codeText}>{inviteCode}</Text>
                </View>

                <Pressable
                    style={styles.shareButton}
                    onPress={handleShare}
                    accessibilityRole="button"
                    accessibilityLabel="Share invite code"
                >
                    <Text style={styles.shareButtonText}>Share Invite Code</Text>
                </Pressable>

                <Pressable
                    style={styles.doneButton}
                    onPress={() => router.back()}
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                >
                    <Text style={styles.doneButtonText}>Done</Text>
                </Pressable>
            </View>
        )

        return (
            <>
                <Stack.Screen options={{ title: 'Create League', presentation: 'modal', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    {renderScreenHeader('League Created')}
                    {successContent}
                </SafeAreaView>
            </>
        )
    }

    const formContent = isCompactLandscape ? (
        <>
            <View style={styles.compactFormRow}>
                <View style={styles.compactField}>
                    <Text style={[styles.label, styles.compactLabel]}>League Name</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. Hoops Dynasty"
                        placeholderTextColor={colors.textPlaceholder}
                        value={leagueName}
                        onChangeText={setLeagueName}
                        accessibilityLabel="League name"
                    />
                </View>

                <View style={styles.compactField}>
                    <Text style={[styles.label, styles.compactLabel]}>Your Team Name</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. Buckets BC"
                        placeholderTextColor={colors.textPlaceholder}
                        value={teamName}
                        onChangeText={setTeamName}
                        accessibilityLabel="Your team name"
                    />
                </View>
            </View>

            <View style={styles.compactFormRow}>
                <View style={styles.compactField}>
                    <Text style={[styles.label, styles.compactLabel]}>Auction Budget per Team ($)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="200"
                        placeholderTextColor={colors.textPlaceholder}
                        keyboardType="number-pad"
                        value={auctionBudget}
                        onChangeText={setAuctionBudget}
                        accessibilityLabel="Auction budget per team"
                    />
                </View>

                <View style={[styles.compactField, styles.compactActionField]}>
                    <Pressable
                        style={[styles.button, styles.compactButton]}
                        onPress={handleCreate}
                        disabled={loading}
                        accessibilityRole="button"
                        accessibilityLabel="Create league"
                    >
                        <Text style={styles.buttonText}>Create League</Text>
                    </Pressable>
                </View>
            </View>

            <View style={styles.compactMetaRow}>
                <Text style={styles.hint}>Default is $200. All managers get the same budget.</Text>
                {error && <Text style={styles.error}>{error}</Text>}
            </View>
        </>
    ) : (
        <>
            <Text style={styles.label}>League Name</Text>
            <TextInput
                style={styles.input}
                placeholder="e.g. Hoops Dynasty"
                placeholderTextColor={colors.textPlaceholder}
                value={leagueName}
                onChangeText={setLeagueName}
                accessibilityLabel="League name"
            />

            <Text style={styles.label}>Your Team Name</Text>
            <TextInput
                style={styles.input}
                placeholder="e.g. Buckets BC"
                placeholderTextColor={colors.textPlaceholder}
                value={teamName}
                onChangeText={setTeamName}
                accessibilityLabel="Your team name"
            />

            <Text style={styles.label}>Auction Budget per Team ($)</Text>
            <TextInput
                style={styles.input}
                placeholder="200"
                placeholderTextColor={colors.textPlaceholder}
                keyboardType="number-pad"
                value={auctionBudget}
                onChangeText={setAuctionBudget}
                accessibilityLabel="Auction budget per team"
            />
            <Text style={styles.hint}>Default is $200. All managers get the same budget.</Text>

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
                style={styles.button}
                onPress={handleCreate}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Create league"
            >
                <Text style={styles.buttonText}>Create League</Text>
            </Pressable>
        </>
    )

    return (
        <>
            <Stack.Screen options={{ title: 'Create League', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {renderScreenHeader('Create League')}
                <KeyboardAvoidingView
                    style={styles.flex1}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                >
                    <ScrollView
                        contentContainerStyle={[styles.inner, isCompactLandscape && styles.compactInner]}
                        keyboardShouldPersistTaps="handled"
                    >
                        {formContent}
                    </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    flex1: { flex: 1 },
    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
    },
    inner: { padding: spacing['3xl'], gap: spacing.md, width: '100%', maxWidth: 560, alignSelf: 'center' },
    compactInner: {
        maxWidth: 640,
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        paddingHorizontal: spacing['2xl'],
        gap: spacing.sm,
    },
    compactFormRow: { flexDirection: 'row', gap: spacing.md },
    compactField: { flex: 1, minWidth: 0, gap: spacing.sm },
    compactActionField: { justifyContent: 'flex-end' },
    compactLabel: { marginTop: 0 },
    compactButton: { marginTop: 0 },
    compactMetaRow: { minHeight: 18, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
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
    error: { color: colors.danger, fontSize: fontSize.md, marginTop: spacing.md },
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
    compactSuccessContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing['2xl'],
        gap: spacing['2xl'],
    },
    compactSuccessCopy: { flex: 1, maxWidth: 320, gap: spacing.md },
    compactSuccessActions: { width: 220, gap: spacing.md, justifyContent: 'center' },
    successTitle: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold },
    successSub: { fontSize: 15, color: colors.textMuted, textAlign: 'center' },
    codeBox: {
        alignSelf: 'stretch',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderWidth: 2,
        borderColor: colors.primary,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous' as const,
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.xl,
        marginVertical: spacing.md,
    },
    codeText: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: colors.primaryDark, letterSpacing: 0, textAlign: 'center' },
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
