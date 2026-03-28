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
                <Text style={styles.title}>Pancake</Text>
                <Text style={styles.subtitle}>Dynasty Fantasy Basketball</Text>

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <TextInput
                    style={styles.input}
                    placeholder="Email"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    value={email}
                    onChangeText={setEmail}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Password"
                    placeholderTextColor={colors.textMuted}
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
        gap: spacing.lg,
    },
    title: {
        fontSize: fontSize['5xl'],
        fontWeight: fontWeight.extrabold,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    subtitle: {
        fontSize: 15,
        color: palette.gray800,
        textAlign: 'center',
        marginBottom: spacing['3xl'],
    },
    error: {
        color: palette.redBright,
        fontSize: fontSize.md,
        textAlign: 'center',
    },
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
    button: {
        height: 50,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: spacing.md,
    },
    buttonText: {
        color: colors.textWhite,
        fontWeight: fontWeight.bold,
        fontSize: fontSize.lg,
    },
    link: {
        textAlign: 'center',
        color: colors.primary,
        marginTop: spacing.lg,
        fontSize: fontSize.md,
    },
})
