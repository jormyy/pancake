import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { joinLeague } from '@/lib/league'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/alert'

export default function JoinLeagueScreen() {
    const { user } = useAuth()
    const { refresh } = useLeagueContext()
    const router = useRouter()
    const [inviteCode, setInviteCode] = useState('')
    const [teamName, setTeamName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
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

    async function handleJoin() {
        if (!inviteCode.trim() || !teamName.trim()) {
            setError('Invite code and team name are required.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await joinLeague(inviteCode.trim(), user!.id, teamName.trim())
            await refresh()
            router.back()
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    function renderScreenHeader() {
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
                    Join League
                </Text>
            </View>
        )
    }

    const formContent = isCompactLandscape ? (
        <>
            <View style={styles.compactFormRow}>
                <View style={styles.compactField}>
                    <Text style={[styles.label, styles.compactLabel]}>Invite Code</Text>
                    <TextInput
                        style={[styles.input, styles.codeInput]}
                        placeholder="XXXXXX"
                        placeholderTextColor={colors.textPlaceholder}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        value={inviteCode}
                        onChangeText={(t) => setInviteCode(t.toUpperCase())}
                        accessibilityLabel="Invite code"
                    />
                </View>

                <View style={styles.compactField}>
                    <Text style={[styles.label, styles.compactLabel]}>Your Team Name</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. Buckets FC"
                        placeholderTextColor={colors.textPlaceholder}
                        value={teamName}
                        onChangeText={setTeamName}
                        accessibilityLabel="Your team name"
                    />
                </View>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
                style={[styles.button, styles.compactButton]}
                onPress={handleJoin}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Join league"
            >
                <Text style={styles.buttonText}>Join League</Text>
            </Pressable>
        </>
    ) : (
        <>
            <Text style={styles.label}>Invite Code</Text>
            <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="XXXXXX"
                placeholderTextColor={colors.textPlaceholder}
                autoCapitalize="characters"
                autoCorrect={false}
                value={inviteCode}
                onChangeText={(t) => setInviteCode(t.toUpperCase())}
                accessibilityLabel="Invite code"
            />

            <Text style={styles.label}>Your Team Name</Text>
            <TextInput
                style={styles.input}
                placeholder="e.g. Buckets FC"
                placeholderTextColor={colors.textPlaceholder}
                value={teamName}
                onChangeText={setTeamName}
                accessibilityLabel="Your team name"
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
                style={styles.button}
                onPress={handleJoin}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Join league"
            >
                <Text style={styles.buttonText}>Join League</Text>
            </Pressable>
        </>
    )

    return (
        <>
            <Stack.Screen options={{ title: 'Join League', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {renderScreenHeader()}
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
    inner: { flexGrow: 1, padding: spacing['3xl'], gap: spacing.md, width: '100%', maxWidth: 560, alignSelf: 'center' },
    compactInner: {
        maxWidth: 640,
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        paddingHorizontal: spacing['2xl'],
        gap: spacing.md,
    },
    compactFormRow: { flexDirection: 'row', gap: spacing.md },
    compactField: { flex: 1, minWidth: 0, gap: spacing.sm },
    compactLabel: { marginTop: 0 },
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
        letterSpacing: 0,
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
    compactButton: { width: 220, alignSelf: 'center', marginTop: spacing.sm },
    buttonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
