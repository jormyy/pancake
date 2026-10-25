import { Link } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { AuthScaffold } from '@/components/auth/AuthScaffold'
import type { AuthHeroContent } from '@/components/auth/AuthHero'
import { Button, Input } from '@/components/ui'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

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

export function SignInForm({ email, password, loading, error, restorationNotice, setEmail, setPassword, onSubmit }: {
    email: string
    password: string
    loading: boolean
    error: string | null
    restorationNotice: string | null
    setEmail: (value: string) => void
    setPassword: (value: string) => void
    onSubmit: () => void
}) {
    return (
        <AuthScaffold
            title="Sign in"
            hero={SIGN_IN_HERO}
            footer={(
                <Link href="/(auth)/sign-up" style={signinStyles.link}>
                    New to Pancake? Create an account
                </Link>
            )}
        >
            {!error && restorationNotice ? <Text style={signinStyles.error} accessibilityLiveRegion="polite">{restorationNotice}</Text> : null}
            {error ? <Text style={signinStyles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

            <View style={signinStyles.formBlock}>
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
                    onSubmitEditing={onSubmit}
                />
                <Button title="Sign In" size="lg" fullWidth loading={loading} onPress={onSubmit} style={signinStyles.submit} />
            </View>
        </AuthScaffold>
    )
}

const signinStyles = StyleSheet.create({
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

export function SignUpForm({ email, password, username, displayName, loading, error, setEmail, setPassword, setUsername, setDisplayName, onSubmit }: {
    email: string
    password: string
    username: string
    displayName: string
    loading: boolean
    error: string | null
    setEmail: (value: string) => void
    setPassword: (value: string) => void
    setUsername: (value: string) => void
    setDisplayName: (value: string) => void
    onSubmit: () => void
}) {
    return (
        <AuthScaffold
            title="Create account"
            hero={SIGN_UP_HERO}
            footer={(
                <Link href="/(auth)/sign-in" style={signupStyles.link}>
                    Already have an account? Sign in
                </Link>
            )}
        >
            {error ? <Text style={signupStyles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

            <View style={signupStyles.formBlock}>
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
                    onSubmitEditing={onSubmit}
                />
                <Button title="Create Account" size="lg" fullWidth loading={loading} onPress={onSubmit} style={signupStyles.submit} />
            </View>
        </AuthScaffold>
    )
}

const signupStyles = StyleSheet.create({
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
