import { Link, useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { AuthScaffold } from '@/components/auth/AuthScaffold'
import type { AuthHeroContent } from '@/components/auth/AuthHero'
import { Button, Input } from '@/components/ui'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/shared/errors'
import { signIn } from '@/lib/auth'

const SIGN_IN_HERO: AuthHeroContent = {
    kicker: 'Dynasty basketball operations',
    title: 'A calmer command center for serious dynasty leagues.',
    copy: 'Pancake keeps the season moving: live scoring, future picks, waivers, auctions, rookie drafts, and roster rules in one fast web app.',
    proofItems: [
        'Daily lineup decisions stay close to live NBA context.',
        'Trades include players, FAAB, and long-horizon pick assets.',
        'Commissioner tools stay available without leaving the app shell.',
        'Player search, projections, and dynasty ranks share one workflow.',
    ],
    previewTitle: 'Tonight',
    previewBadge: 'Live board',
    previewRows: [
        { label: 'Lineup edge', value: '+42.6' },
        { label: 'Waiver budget', value: '$61' },
        { label: 'Pick bank', value: '15 assets' },
    ],
}

export default function SignInScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const router = useRouter()

    async function handleSignIn() {
        if (!email || !password) {
            setError('Please fill in all fields.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await signIn(email.trim(), password)
            if (Platform.OS === 'web' && typeof window !== 'undefined') {
                window.location.assign('/')
            } else {
                router.replace('/')
            }
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <AuthScaffold
            eyebrow="Dynasty hoops"
            title="Welcome back"
            subtitle="Manage lineups, claims, trades, draft rooms, and long-term roster value from one console."
            hero={SIGN_IN_HERO}
            footer={(
                <Link href="/(auth)/sign-up" style={styles.link}>
                    New to Pancake? Create an account
                </Link>
            )}
        >
            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

            <View style={styles.formBlock}>
                <Input
                    label="Email"
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    value={email}
                    onChangeText={setEmail}
                />
                <Input
                    label="Password"
                    placeholder="Your password"
                    secureTextEntry
                    autoComplete="password"
                    textContentType="password"
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={handleSignIn}
                />
                <Button title="Sign In" size="lg" fullWidth loading={loading} onPress={handleSignIn} style={styles.submit} />
            </View>
        </AuthScaffold>
    )
}

const styles = StyleSheet.create({
    error: {
        color: colors.danger,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        marginBottom: spacing.lg,
    },
    formBlock: { gap: spacing.lg },
    submit: { marginTop: spacing.sm },
    link: {
        textAlign: 'center',
        color: colors.primaryDark,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
})
