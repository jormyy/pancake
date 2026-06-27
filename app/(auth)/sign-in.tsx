import {
    View,
    Text,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    useWindowDimensions,
} from 'react-native'
import { Link } from 'expo-router'
import { useState } from 'react'
import { signIn } from '@/lib/auth'
import { brand, colors, elevation, fontSize, fontWeight, radii, spacing, breakpoints } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/alert'
import { Button, Input } from '@/components/ui'

export default function SignInScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { width } = useWindowDimensions()
    const split = Platform.OS === 'web' && width >= breakpoints.auth

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
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={[styles.shell, split && styles.shellSplit]}>
                {split ? <BrandPanel /> : null}

                <View style={styles.formPanel}>
                    <View style={[styles.formCard, !split && styles.formCardMobile]}>
                        {!split ? <MobileBrand /> : null}

                        <View style={styles.titleBlock}>
                            <Text style={styles.eyebrow}>Dynasty Hoops</Text>
                            <Text style={styles.title}>Welcome back</Text>
                            <Text style={styles.subtitle}>Sign in to manage your dynasty league.</Text>
                        </View>

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

                        <Link href="/(auth)/sign-up" style={styles.link}>
                            New to Pancake? Create an account
                        </Link>
                    </View>
                </View>
            </View>
        </KeyboardAvoidingView>
    )
}

function BrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <View style={[styles.brandMark, compact && styles.brandMarkCompact]}>
            <Text style={[styles.brandMarkText, compact && styles.brandMarkTextCompact]}>P</Text>
        </View>
    )
}

function BrandPanel() {
    return (
        <View style={styles.brandPanel}>
            <View style={styles.brandTop}>
                <BrandMark />
                <View>
                    <Text style={styles.brandName}>Pancake</Text>
                    <Text style={styles.brandSub}>Dynasty Hoops</Text>
                </View>
            </View>

            <View style={styles.brandMiddle}>
                <Text style={styles.brandHeadline}>Dynasty hoops, done right.</Text>
                <Text style={styles.brandCopy}>
                    Live matchups, roster rules, trades, waivers, auction drafts, rookie drafts, and long-term league tools in one clean manager console.
                </Text>
                <View style={styles.featureList}>
                    <FeatureLine title="Live scoring and lineup decisions" />
                    <FeatureLine title="Future-pick trades and waiver integrity" />
                    <FeatureLine title="Auction, rookie drafts, IR, and taxi squads" />
                </View>
            </View>

            <Text style={styles.brandFoot}>Built for serious dynasty basketball leagues.</Text>
        </View>
    )
}

function MobileBrand() {
    return (
        <View style={styles.mobileBrand}>
            <BrandMark compact />
            <View>
                <Text style={styles.mobileBrandName}>Pancake</Text>
                <Text style={styles.mobileBrandSub}>Dynasty Hoops</Text>
            </View>
        </View>
    )
}

function FeatureLine({ title }: { title: string }) {
    return (
        <View style={styles.featureLine}>
            <View style={styles.featureDot} />
            <Text style={styles.featureText}>{title}</Text>
        </View>
    )
}

type WebAuthStyle = {
    backgroundImage?: string
    boxShadow?: string
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    shell: { flex: 1 },
    shellSplit: { flexDirection: 'row' },

    brandPanel: {
        flex: 1.05,
        padding: 56,
        backgroundColor: brand.surfaceDeep,
        backgroundImage: `linear-gradient(150deg, ${brand.surface} 0%, ${brand.surfaceDeeper} 100%)`,
    } as WebAuthStyle,
    brandTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    brandMark: {
        width: 46,
        height: 46,
        borderRadius: radii.xl,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
        ...(elevation('brandGlow') as object),
    },
    brandMarkCompact: {
        width: 40,
        height: 40,
        borderRadius: radii.lg,
    },
    brandMarkText: {
        color: brand.on,
        fontSize: 24,
        fontWeight: fontWeight.extrabold,
    },
    brandMarkTextCompact: { fontSize: 21 },
    brandName: {
        color: brand.on,
        fontSize: 22,
        fontWeight: fontWeight.extrabold,
    },
    brandSub: {
        marginTop: -2,
        color: brand.onSubtle,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
    },
    brandMiddle: {
        flex: 1,
        justifyContent: 'center',
        maxWidth: 520,
    },
    brandHeadline: {
        color: brand.on,
        fontSize: 44,
        lineHeight: 48,
        fontWeight: fontWeight.extrabold,
        letterSpacing: -1,
    },
    brandCopy: {
        marginTop: spacing.xl,
        color: brand.onMuted,
        fontSize: fontSize.lg,
        lineHeight: 24,
        maxWidth: 460,
    },
    featureList: {
        marginTop: spacing['4xl'],
        gap: spacing.lg,
    },
    featureLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    featureDot: {
        width: 12,
        height: 12,
        borderRadius: radii.full,
        backgroundColor: colors.primaryBorder,
    },
    featureText: {
        color: brand.onStrong,
        fontSize: 15,
        fontWeight: fontWeight.semibold,
    },
    brandFoot: {
        color: brand.onFaint,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
    },

    formPanel: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['4xl'],
    },
    formCard: {
        width: '100%',
        maxWidth: 392,
    },
    formCardMobile: { maxWidth: 430 },
    mobileBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginBottom: spacing['4xl'],
    },
    mobileBrandName: {
        color: colors.textPrimary,
        fontSize: 21,
        fontWeight: fontWeight.extrabold,
    },
    mobileBrandSub: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        letterSpacing: 1.8,
        textTransform: 'uppercase' as const,
    },
    titleBlock: { marginBottom: spacing['3xl'] },
    eyebrow: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1.5,
        textTransform: 'uppercase' as const,
        marginBottom: spacing.sm,
    },
    title: {
        color: colors.textPrimary,
        fontSize: 30,
        lineHeight: 34,
        fontWeight: fontWeight.extrabold,
        letterSpacing: -0.5,
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: fontSize.md,
        marginTop: spacing.sm,
    },
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
        marginTop: spacing['3xl'],
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
})
