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
    useWindowDimensions,
} from 'react-native'
import { Link } from 'expo-router'
import { useState } from 'react'
import { signUp } from '@/lib/auth'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/alert'

export default function SignUpScreen() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [username, setUsername] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { width } = useWindowDimensions()
    const split = Platform.OS === 'web' && width >= 860

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
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={[styles.shell, split && styles.shellSplit]}>
                {split ? <BrandPanel /> : null}

                <View style={styles.formPanel}>
                    <ScrollView
                        contentContainerStyle={[styles.scroll, split && styles.scrollSplit]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={[styles.formCard, !split && styles.formCardMobile]}>
                            {!split ? <MobileBrand /> : null}

                            <View style={styles.titleBlock}>
                                <Text style={styles.eyebrow}>Create Account</Text>
                                <Text style={styles.title}>Start your dynasty</Text>
                                <Text style={styles.subtitle}>Create your manager profile, then create or join a league.</Text>
                            </View>

                            {error ? <Text style={styles.error}>{error}</Text> : null}

                            <View style={styles.formBlock}>
                                <Field label="Display name">
                                    <TextInput
                                        style={styles.input}
                                        placeholder="Maple Manager"
                                        placeholderTextColor={colors.textPlaceholder}
                                        textContentType="name"
                                        value={displayName}
                                        onChangeText={setDisplayName}
                                    />
                                </Field>

                                <Field label="Username">
                                    <TextInput
                                        style={styles.input}
                                        placeholder="hoopsgod"
                                        placeholderTextColor={colors.textPlaceholder}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        value={username}
                                        onChangeText={(value) => setUsername(value.toLowerCase())}
                                    />
                                </Field>

                                <Field label="Email">
                                    <TextInput
                                        style={styles.input}
                                        placeholder="you@example.com"
                                        placeholderTextColor={colors.textPlaceholder}
                                        autoCapitalize="none"
                                        keyboardType="email-address"
                                        textContentType="emailAddress"
                                        value={email}
                                        onChangeText={setEmail}
                                    />
                                </Field>

                                <Field label="Password">
                                    <TextInput
                                        style={styles.input}
                                        placeholder="Minimum 8 characters"
                                        placeholderTextColor={colors.textPlaceholder}
                                        secureTextEntry
                                        textContentType="newPassword"
                                        value={password}
                                        onChangeText={setPassword}
                                    />
                                </Field>

                                <Pressable style={styles.button} onPress={handleSignUp} disabled={loading}>
                                    {loading ? (
                                        <ActivityIndicator color={colors.textWhite} />
                                    ) : (
                                        <Text style={styles.buttonText}>Create Account</Text>
                                    )}
                                </Pressable>
                            </View>

                            <Link href="/(auth)/sign-in" style={styles.link}>
                                Already have an account? Sign in
                            </Link>
                        </View>
                    </ScrollView>
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
                <Text style={styles.brandHeadline}>Build a league with staying power.</Text>
                <Text style={styles.brandCopy}>
                    Create your manager profile, join a dynasty room, and carry auction values, rookie picks, waivers, trades, IR, and taxi squads across seasons.
                </Text>
                <View style={styles.featureList}>
                    <FeatureLine title="Ten-team leagues with five-year pick banks" />
                    <FeatureLine title="Auction and rookie drafts built into the flow" />
                    <FeatureLine title="Roster rules that survive the offseason" />
                </View>
            </View>

            <Text style={styles.brandFoot}>No redraft shortcuts. No fake league tools.</Text>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <View style={styles.field}>
            <Text style={styles.fieldLabel}>{label}</Text>
            {children}
        </View>
    )
}

type WebAuthStyle = {
    backgroundImage?: string
    boxShadow?: string
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    shell: {
        flex: 1,
    },
    shellSplit: {
        flexDirection: 'row',
    },
    brandPanel: {
        flex: 1.05,
        padding: 56,
        backgroundColor: '#1A1008',
        backgroundImage: 'linear-gradient(150deg, #2A1A0E 0%, #160D06 100%)',
    } as WebAuthStyle,
    brandTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    brandMiddle: {
        flex: 1,
        justifyContent: 'center',
        maxWidth: 520,
    },
    brandHeadline: {
        color: '#FFF7EC',
        fontSize: 44,
        lineHeight: 48,
        fontWeight: fontWeight.extrabold,
        letterSpacing: -1,
    },
    brandCopy: {
        marginTop: spacing.xl,
        color: '#C9A988',
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
        backgroundColor: colors.primary,
    },
    featureText: {
        color: '#E6D2B6',
        fontSize: 15,
        fontWeight: fontWeight.semibold,
    },
    brandFoot: {
        color: '#8C6A4C',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
    },
    brandName: {
        color: '#FFF6E8',
        fontSize: 22,
        fontWeight: fontWeight.extrabold,
    },
    brandSub: {
        marginTop: -2,
        color: '#B98E64',
        fontSize: 10,
        fontWeight: fontWeight.bold,
        letterSpacing: 2,
        textTransform: 'uppercase' as const,
    },
    formPanel: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['4xl'],
    },
    scroll: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        paddingHorizontal: 28,
        paddingVertical: 48,
    },
    scrollSplit: {
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    formCard: {
        width: '100%',
        maxWidth: 392,
    },
    formCardMobile: {
        maxWidth: 430,
    },
    mobileBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginBottom: spacing['4xl'],
    },
    brandMark: {
        width: 46,
        height: 46,
        borderRadius: radii.xl,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
        boxShadow: '0 6px 18px rgba(201, 102, 15, 0.5)',
    } as WebAuthStyle,
    brandMarkCompact: {
        width: 40,
        height: 40,
        borderRadius: radii.lg,
    },
    brandMarkText: {
        color: '#FFF6E8',
        fontSize: 24,
        fontWeight: fontWeight.extrabold,
    },
    brandMarkTextCompact: {
        fontSize: 21,
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
    titleBlock: {
        marginBottom: spacing['3xl'],
    },
    eyebrow: {
        color: colors.primary,
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
    formBlock: {
        gap: spacing.lg,
    },
    field: {
        gap: spacing.sm,
    },
    fieldLabel: {
        color: colors.textMuted,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
    },
    input: {
        height: 52,
        borderWidth: 1,
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
        marginTop: spacing.sm,
        boxShadow: '0 4px 14px rgba(201, 102, 15, 0.36)',
    } as WebAuthStyle,
    buttonText: {
        color: colors.textWhite,
        fontWeight: fontWeight.extrabold,
        fontSize: fontSize.lg,
    },
    link: {
        textAlign: 'center',
        color: colors.primary,
        marginTop: spacing['3xl'],
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
})
