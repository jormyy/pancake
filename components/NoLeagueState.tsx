import { Platform, View, Text, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useRouter } from 'expo-router'
import { colors, elevation, fontFamily, fontSize, fontWeight, radii, shadows, spacing } from '@/constants/tokens'
import { Button } from '@/components/ui'

const FEATURES: { icon: 'sports-basketball' | 'groups' | 'swap-horiz'; text: string }[] = [
    { icon: 'sports-basketball', text: 'Live weekly matchups & auto-set lineups' },
    { icon: 'groups', text: 'Auction + rookie drafts, IR and taxi squads' },
    { icon: 'swap-horiz', text: 'Future-pick trades and waiver integrity' },
]

export function NoLeagueState() {
    const { push } = useRouter()
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.inner}>
                <View style={styles.brandMark}>
                    <Text style={styles.brandMarkText}>P</Text>
                </View>
                <Text style={styles.eyebrow}>Dynasty Hoops</Text>
                <Text style={styles.title}>Welcome to Pancake</Text>
                <Text style={styles.sub}>
                    You&apos;re not in a league yet. Create your own dynasty room, or join an existing one with an invite code.
                </Text>

                <View style={styles.features}>
                    {FEATURES.map((f) => (
                        <View key={f.text} style={styles.featureRow}>
                            <View style={styles.featureIcon}>
                                <MaterialIcons name={f.icon} size={18} color={colors.primary} />
                            </View>
                            <Text style={styles.featureText}>{f.text}</Text>
                        </View>
                    ))}
                </View>

                <View style={styles.actions}>
                    <Button title="Create a League" size="lg" fullWidth icon="add" onPress={() => push('/(modals)/create-league')} />
                    <Button title="Join with Invite Code" size="lg" variant="outline" fullWidth icon="vpn-key" onPress={() => push('/(modals)/join-league')} />
                </View>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.bgScreen,
        backgroundImage: 'radial-gradient(circle at 78% 8%, rgba(47, 122, 91, 0.12), transparent 34%), linear-gradient(145deg, #FFFDF7, #F7F1E8)',
    },
    inner: {
        margin: spacing['3xl'],
        padding: spacing['4xl'],
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii['2xl'],
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing['4xl'],
        gap: spacing.md,
        maxWidth: 520,
        width: '100%',
        alignSelf: 'center',
        ...(Platform.OS === 'web' ? { boxShadow: shadows.lg } : {}),
    },
    brandMark: {
        width: 56,
        height: 56,
        borderRadius: radii['2xl'],
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.sm,
        ...(elevation('brandGlow') as object),
    },
    brandMarkText: { color: colors.textWhite, fontSize: 28, fontFamily: fontFamily.display, fontWeight: fontWeight.extrabold },
    eyebrow: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1,
        textTransform: 'uppercase',
    },
    title: { fontSize: fontSize['4xl'], fontFamily: fontFamily.display, fontWeight: fontWeight.black, color: colors.textPrimary, textAlign: 'center' },
    sub: {
        fontSize: fontSize.md,
        color: colors.textMuted,
        textAlign: 'center',
        lineHeight: 21,
        marginBottom: spacing.md,
    },
    features: {
        width: '100%',
        gap: spacing.md,
        marginBottom: spacing.xl,
    },
    featureRow: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        backgroundColor: colors.bgSubtle,
    },
    featureIcon: {
        width: 34,
        height: 34,
        borderRadius: radii.md,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    featureText: { flex: 1, fontSize: fontSize.md, color: colors.textSecondary, fontWeight: fontWeight.semibold },
    actions: { width: '100%', gap: spacing.md },
})
