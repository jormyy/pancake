import { Link } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AuthScaffold } from '@/components/auth/AuthScaffold'
import type { AuthHeroContent } from '@/components/auth/AuthHero'
import { Button, Input } from '@/components/ui'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/shared/errors'
import { signUp } from '@/lib/auth'

const SIGN_UP_HERO: AuthHeroContent = {
    title: 'Set up the league before the league sets the agenda.',
    copy: 'Real roster limits, pick banks, waivers, auctions, and rookie drafts from day one.',
    proofItems: [
        'Five-year pick banks come with every league.',
        'Draft rooms stay in sync with rosters.',
        'Lineup slots, IR, and taxi rules travel together.',
        'Join, draft, trade, and claim in one place.',
    ],
}

export default function SignUpScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [username, setUsername] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleSignUp() {
        if (!email || !password || !username || !displayName) {
            setError('Please fill in all fields.')
            return
        }
        if (password.length < 8) {
            setError('Password must be at least 8 characters.')
            return
        }
        if (!/^[a-z0-9_]+$/.test(username)) {
            setError('Username can only contain lowercase letters, numbers, and underscores.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await signUp(email.trim(), password, username.trim(), displayName.trim())
        } catch (e) {
            setError(getErrorMessage(e) ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <AuthScaffold
            eyebrow="Create account"
            title="Start your dynasty"
            hero={SIGN_UP_HERO}
            footer={(
                <Link href="/(auth)/sign-in" style={styles.link}>
                    Already have an account? Sign in
                </Link>
            )}
        >
            {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

            <View style={styles.formBlock}>
                <Input
                    label="Display name"
                    placeholder="Maple Manager"
                    autoComplete="name"
                    textContentType="name"
                    value={displayName}
                    onChangeText={setDisplayName}
                />
                <Input
                    label="Username"
                    placeholder="hoopsgod"
                    autoCapitalize="none"
                    autoCorrect={false}
                    hint="Lowercase letters, numbers, underscores"
                    value={username}
                    onChangeText={(value) => setUsername(value.toLowerCase())}
                />
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
                    placeholder="Minimum 8 characters"
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={handleSignUp}
                />
                <Button title="Create Account" size="lg" fullWidth loading={loading} onPress={handleSignUp} style={styles.submit} />
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
