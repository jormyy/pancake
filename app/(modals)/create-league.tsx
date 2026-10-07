import {
    View,
    Text,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Share,
    useWindowDimensions,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { createLeague } from '@/lib/league'
import { colors, fontFamily, fontSize, fontWeight, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { Button, Input, usePageMetrics } from '@/components/ui'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { getErrorMessage } from '@/lib/shared/errors'

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
    const { padX } = usePageMetrics()

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

    // Success state — show invite code
    if (inviteCode) {
        return (
            <>
                <Stack.Screen options={{ title: 'Create League', presentation: 'modal', headerShown: false }} />
                <ModalScreen title="League created" onBack={() => router.back()}>
                    <View style={[styles.successContainer, isCompactLandscape && styles.compactSuccessContainer]}>
                        <View style={[styles.successCopy, isCompactLandscape && styles.compactSuccessCopy]}>
                            <Text style={styles.successSub}>Share this code with your managers.</Text>
                            <View style={styles.codeBox}>
                                <Text style={styles.codeText} selectable>{inviteCode}</Text>
                            </View>
                        </View>
                        <View style={[styles.successActions, isCompactLandscape && styles.compactSuccessActions]}>
                            <Button title="Share Invite Code" icon="ios-share" onPress={handleShare} fullWidth accessibilityLabel="Share invite code" />
                            <Button title="Done" variant="secondary" onPress={() => router.back()} fullWidth accessibilityLabel="Done" />
                        </View>
                    </View>
                </ModalScreen>
            </>
        )
    }

    const leagueField = (
        <Input
            label="League name"
            placeholder="e.g. Hoops Dynasty"
            value={leagueName}
            onChangeText={setLeagueName}
            accessibilityLabel="League name"
            containerStyle={isCompactLandscape ? styles.compactField : undefined}
        />
    )
    const teamField = (
        <Input
            label="Your team name"
            placeholder="e.g. Buckets BC"
            value={teamName}
            onChangeText={setTeamName}
            accessibilityLabel="Your team name"
            containerStyle={isCompactLandscape ? styles.compactField : undefined}
        />
    )
    const budgetField = (
        <Input
            label="Auction budget per team ($)"
            placeholder="200"
            keyboardType="number-pad"
            value={auctionBudget}
            onChangeText={setAuctionBudget}
            accessibilityLabel="Auction budget per team"
            hint={isCompactLandscape ? undefined : 'Every manager gets the same budget.'}
            containerStyle={isCompactLandscape ? styles.compactField : undefined}
        />
    )
    const createButton = (
        <Button title="Create League" onPress={handleCreate} loading={loading} fullWidth accessibilityLabel="Create league" />
    )

    return (
        <>
            <Stack.Screen options={{ title: 'Create League', presentation: 'modal', headerShown: false }} />
            <ModalScreen title="Create League" onBack={() => router.back()}>
                <KeyboardAvoidingView
                    style={styles.flex1}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                >
                    <ScrollView
                        contentContainerStyle={[styles.inner, { paddingHorizontal: padX }, isCompactLandscape && styles.compactInner]}
                        keyboardShouldPersistTaps="handled"
                    >
                        {isCompactLandscape ? (
                            <>
                                <View style={styles.compactFormRow}>{leagueField}{teamField}</View>
                                <View style={styles.compactFormRow}>
                                    {budgetField}
                                    <View style={[styles.compactField, styles.compactActionField]}>{createButton}</View>
                                </View>
                            </>
                        ) : (
                            <>
                                {leagueField}
                                {teamField}
                                {budgetField}
                            </>
                        )}
                        {error ? <Text style={styles.error}>{error}</Text> : null}
                        {isCompactLandscape ? null : <View style={styles.action}>{createButton}</View>}
                    </ScrollView>
                </KeyboardAvoidingView>
            </ModalScreen>
        </>
    )
}

const styles = StyleSheet.create({
    flex1: { flex: 1 },
    inner: {
        paddingTop: spacing.xl,
        paddingBottom: spacing['4xl'],
        gap: spacing.lg,
        width: '100%',
        maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular,
        alignSelf: 'center',
    },
    compactInner: { paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.sm },
    compactFormRow: { flexDirection: 'row', gap: spacing.md },
    compactField: { flex: 1, minWidth: 0 },
    compactActionField: { justifyContent: 'flex-end' },
    error: { ...textStyles.body, color: colors.dangerDark },
    action: { marginTop: spacing.md },

    // Success state
    successContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['3xl'],
        gap: spacing.xl,
    },
    compactSuccessContainer: { flexDirection: 'row', paddingVertical: spacing.md, gap: spacing['2xl'] },
    successCopy: { width: '100%', maxWidth: 420, gap: spacing.md, alignItems: 'center' },
    compactSuccessCopy: { flex: 1 },
    successActions: { width: '100%', maxWidth: 420, gap: spacing.md },
    compactSuccessActions: { width: 220 },
    successSub: { ...textStyles.body, textAlign: 'center' },
    codeBox: {
        alignSelf: 'stretch',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.xl,
    },
    codeText: { fontSize: fontSize.xl, fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.primaryDark, letterSpacing: 1, textAlign: 'center' },
})
