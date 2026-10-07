import {
    View,
    Text,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { joinLeague } from '@/lib/league'
import { colors, fontSize, fontWeight, layout, spacing, textStyles } from '@/constants/tokens'
import { Button, Input, usePageMetrics } from '@/components/ui'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { getErrorMessage } from '@/lib/shared/errors'

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
    const { padX } = usePageMetrics()

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

    const codeField = (
        <Input
            label="Invite code"
            placeholder="16-character code"
            autoCapitalize="characters"
            autoCorrect={false}
            value={inviteCode}
            onChangeText={(t) => setInviteCode(t.toUpperCase())}
            accessibilityLabel="Invite code"
            style={styles.codeInput}
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

    return (
        <>
            <Stack.Screen options={{ title: 'Join League', presentation: 'modal', headerShown: false }} />
            <ModalScreen title="Join League" onBack={() => router.back()}>
                <KeyboardAvoidingView
                    style={styles.flex1}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                >
                    <ScrollView
                        contentContainerStyle={[styles.inner, { paddingHorizontal: padX }, isCompactLandscape && styles.compactInner]}
                        keyboardShouldPersistTaps="handled"
                    >
                        {isCompactLandscape ? (
                            <View style={styles.compactFormRow}>{codeField}{teamField}</View>
                        ) : (
                            <>
                                {codeField}
                                {teamField}
                            </>
                        )}
                        {error ? <Text style={styles.error}>{error}</Text> : null}
                        <View style={[styles.action, isCompactLandscape && styles.compactAction]}>
                            <Button title="Join League" onPress={handleJoin} loading={loading} fullWidth accessibilityLabel="Join league" />
                        </View>
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
    codeInput: {
        fontSize: fontSize.xl,
        fontWeight: fontWeight.bold,
        textAlign: 'center',
    },
    error: { ...textStyles.body, color: colors.dangerDark },
    action: { marginTop: spacing.md },
    compactAction: { width: 220, alignSelf: 'center', marginTop: spacing.sm },
})
