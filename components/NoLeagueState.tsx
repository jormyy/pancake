import { View, Text, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useRouter } from 'expo-router'
import { colors, elevation, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
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
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: spacing['4xl'],
        gap: spacing.md,
        maxWidth: 460,
        width: '100%',
        alignSelf: 'center',
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
    brandMarkText: { color: colors.textWhite, fontSize: 28, fontWeight: fontWeight.extrabold },
    eyebrow: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
    },
    title: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary, textAlign: 'center' },
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
    featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    featureIcon: {
        width: 34,
        height: 34,
        borderRadius: radii.md,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    featureText: { flex: 1, fontSize: fontSize.md, color: colors.textSecondary, fontWeight: fontWeight.medium },
    actions: { width: '100%', gap: spacing.md },
})
