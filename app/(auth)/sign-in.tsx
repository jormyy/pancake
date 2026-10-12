import { Link } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AuthScaffold } from '@/components/auth/AuthScaffold'
import type { AuthHeroContent } from '@/components/auth/AuthHero'
import { Button, Input } from '@/components/ui'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/shared/errors'
import { signIn } from '@/lib/auth'
import { useAuth } from '@/hooks/use-auth'

const SIGN_IN_HERO: AuthHeroContent = {
    title: 'A calmer command center for serious dynasty leagues.',
    copy: 'Live scoring, future picks, waivers, auctions, and rookie drafts in one fast app.',
    proofItems: [
        'Set lineups against live NBA games.',
        'Trade players, FAAB, and future picks.',
        'Run auctions and rookie drafts in-app.',
        'Rankings and projections beside every player.',
    ],
}

export default function SignInScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { restorationStatus, loading: authLoading } = useAuth()
    const restorationNotice = authLoading ? null : restorationStatus === 'expired'
        ? 'Your session expired. Reconnect or sign in to continue.'
        : restorationStatus === 'unavailable'
            ? 'Your session cannot be checked. Reconnect or sign in to continue.'
            : restorationStatus === 'invalid' ? 'Sign in again to restore your session.' : null

    async function handleSignIn() {
        if (!email || !password) {
            setError('Please fill in all fields.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await signIn(email.trim(), password)
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
            hero={SIGN_IN_HERO}
            footer={(
                <Link href="/(auth)/sign-up" style={styles.link}>
                    New to Pancake? Create an account
                </Link>
            )}
        >
            {!error && restorationNotice ? <Text style={styles.error} accessibilityLiveRegion="polite">{restorationNotice}</Text> : null}
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
        color: colors.dangerDark,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        marginBottom: spacing.lg,
    },
    formBlock: { gap: spacing.lg },
    submit: { marginTop: spacing.sm },
    // Padded to a 44px tap target.
    link: {
        paddingVertical: spacing.lg,
        textAlign: 'center',
        color: colors.primaryDark,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
})
