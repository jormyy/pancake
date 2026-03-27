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
            // Root layout handles redirect once session updates
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

                {error && <Text style={styles.error}>{error}</Text>}

                <TextInput
                    style={styles.input}
                    placeholder="Display name"
                    placeholderTextColor="#888"
                    textContentType="name"
                    value={displayName}
                    onChangeText={setDisplayName}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Username (e.g. hoopsgod)"
                    placeholderTextColor="#888"
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={username}
                    onChangeText={(t) => setUsername(t.toLowerCase())}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Email"
                    placeholderTextColor="#888"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    value={email}
                    onChangeText={setEmail}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Password (min 8 characters)"
                    placeholderTextColor="#888"
                    secureTextEntry
                    textContentType="newPassword"
                    value={password}
                    onChangeText={setPassword}
                />

                <Pressable style={styles.button} onPress={handleSignUp} disabled={loading}>
                    {loading ? (
                        <ActivityIndicator color="#fff" />
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
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    inner: {
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: 28,
        paddingVertical: 48,
        gap: 12,
    },
    title: {
        fontSize: 32,
        fontWeight: '800',
        textAlign: 'center',
        marginBottom: 4,
    },
    subtitle: {
        fontSize: 15,
        color: '#666',
        textAlign: 'center',
        marginBottom: 24,
    },
    error: {
        color: '#d00',
        fontSize: 14,
        textAlign: 'center',
    },
    input: {
        height: 50,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 16,
        fontSize: 16,
        backgroundColor: '#fafafa',
    },
    button: {
        height: 50,
        backgroundColor: '#F97316',
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 8,
    },
    buttonText: {
        color: '#fff',
        fontWeight: '700',
        fontSize: 16,
    },
    link: {
        textAlign: 'center',
        color: '#F97316',
        marginTop: 12,
        fontSize: 14,
    },
})
