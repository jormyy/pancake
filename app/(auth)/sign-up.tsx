import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    ScrollView,
} from 'react-native'
import { Link } from 'expo-router'
import { useState } from 'react'
import { signUp } from '@/lib/auth'
import { colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'

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
            <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
                <Text style={styles.title}>Create Account</Text>
                <Text style={styles.subtitle}>Join the dynasty</Text>

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <TextInput
                    style={styles.input}
                    placeholder="Display name"
                    placeholderTextColor={colors.textMuted}
                    textContentType="name"
                    value={displayName}
                    onChangeText={setDisplayName}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Username (e.g. hoopsgod)"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={username}
                    onChangeText={(t) => setUsername(t.toLowerCase())}
                />
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
                    placeholder="Password (min 8 characters)"
                    placeholderTextColor={colors.textMuted}
                    secureTextEntry
                    textContentType="newPassword"
                    value={password}
                    onChangeText={setPassword}
                />

                <Pressable style={styles.button} onPress={handleSignUp} disabled={loading}>
                    {loading ? (
                        <ActivityIndicator color={colors.textWhite} />
                    ) : (
                        <Text style={styles.buttonText}>Create Account</Text>
                    )}
                </Pressable>

                <Link href="/(auth)/sign-in" style={styles.link}>
                    Already have an account? Sign in
                </Link>
            </ScrollView>
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: {
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: 28,
        paddingVertical: 48,
        gap: spacing.lg,
    },
    title: {
        fontSize: fontSize['4xl'],
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
