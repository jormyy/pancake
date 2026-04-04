import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
} from 'react-native'
import { Link } from 'expo-router'
import { useState } from 'react'
import { signIn } from '@/lib/auth'
import { colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'

export default function SignInScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function handleSignIn() {
        if (!email || !password) {
            setError('Please fill in all fields.')
            return
        }
        setLoading(true)
        setError(null)
        try {
            await signIn(email.trim(), password)
        } catch (e: any) {
            setError(e.message ?? 'Something went wrong.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={styles.inner}>
                {/* Brand mark */}
                <View style={styles.brandMark}>
                    <Text style={styles.brandEmoji}>🥞</Text>
                    <Text style={styles.brandEmoji}>🏀</Text>
                </View>

                {/* Title block */}
                <View style={styles.titleBlock}>
                    <Text style={styles.title}>PANCAKE</Text>
                    <View style={styles.titleRule} />
                    <Text style={styles.subtitle}>DYNASTY FANTASY BASKETBALL</Text>
                    <Text style={styles.tagline}>Stack your roster.</Text>
                </View>

                {error ? <Text style={styles.error}>{error}</Text> : null}

                {/* Form */}
                <View style={styles.formBlock}>
                    <View style={styles.formDivider}>
                        <View style={styles.formDividerLine} />
                        <Text style={styles.formDividerText}>SIGN IN</Text>
                        <View style={styles.formDividerLine} />
                    </View>

                    <TextInput
                        style={styles.input}
                        placeholder="Email"
                        placeholderTextColor={colors.textPlaceholder}
                        autoCapitalize="none"
                        keyboardType="email-address"
                        textContentType="emailAddress"
                        value={email}
                        onChangeText={setEmail}
                    />
                    <TextInput
                        style={styles.input}
                        placeholder="Password"
                        placeholderTextColor={colors.textPlaceholder}
                        secureTextEntry
                        textContentType="password"
                        value={password}
                        onChangeText={setPassword}
                    />

                    <Pressable style={styles.button} onPress={handleSignIn} disabled={loading}>
                        {loading ? (
                            <ActivityIndicator color={colors.textWhite} />
                        ) : (
                            <Text style={styles.buttonText}>Sign In</Text>
                        )}
                    </Pressable>
                </View>

                <Link href="/(auth)/sign-up" style={styles.link}>
                    Don't have an account? Sign up
                </Link>
            </View>
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 28,
        gap: spacing['2xl'],
    },

    brandMark: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
        marginBottom: -4,
    },
    brandEmoji: {
        fontSize: 48,
    },

    titleBlock: {
        alignItems: 'center',
        gap: spacing.sm,
    },
    title: {
        fontSize: fontSize['5xl'],
        fontWeight: fontWeight.extrabold,
        color: colors.primary,
        letterSpacing: 6,
        textAlign: 'center',
    },
    titleRule: {
        width: 40,
        height: 3,
        backgroundColor: colors.primary,
        borderRadius: 2,
        marginVertical: spacing.xs,
    },
    subtitle: {
        fontSize: 10,
        color: palette.mocha,
        textAlign: 'center',
        fontWeight: fontWeight.bold,
        letterSpacing: 2.5,
    },
    tagline: {
        fontSize: 13,
        color: colors.textPlaceholder,
        textAlign: 'center',
        fontStyle: 'italic' as const,
        marginTop: spacing.xs,
    },

    error: {
        color: palette.redBright,
        fontSize: fontSize.md,
        textAlign: 'center',
    },

    formBlock: {
        gap: spacing.lg,
    },
    formDivider: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        marginBottom: spacing.xs,
    },
    formDividerLine: {
        flex: 1,
        height: 1,
        backgroundColor: colors.border,
    },
    formDividerText: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 2.5,
    },

    input: {
        height: 50,
        borderWidth: 1.5,
        borderColor: colors.border,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.xl,
        fontSize: fontSize.lg,
        backgroundColor: colors.bgInput,
        color: colors.textPrimary,
    },
    button: {
        height: 52,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: spacing.md,
        boxShadow: '0 4px 14px rgba(201, 102, 15, 0.4)',
    },
    buttonText: {
        color: colors.textWhite,
        fontWeight: fontWeight.extrabold,
        fontSize: fontSize.lg,
        letterSpacing: 0.5,
    },

    link: {
        textAlign: 'center',
        color: colors.primary,
        fontSize: fontSize.md,
    },
})
