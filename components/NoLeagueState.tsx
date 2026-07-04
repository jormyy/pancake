import { Platform, View, Text, StyleSheet } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useRouter } from 'expo-router'
import { colors, elevation, fontFamily, fontSize, fontWeight, radii, spacing, webBackgrounds, type WebOnlyViewStyle } from '@/constants/tokens'
import { Button } from '@/components/ui'
import { PromptFrame } from '@/components/ui/PromptFrame'

const FEATURES: { icon: 'sports-basketball' | 'groups' | 'swap-horiz'; text: string }[] = [
    { icon: 'sports-basketball', text: 'Live weekly matchups & auto-set lineups' },
    { icon: 'groups', text: 'Auction + rookie drafts, IR and taxi squads' },
    { icon: 'swap-horiz', text: 'Future-pick trades and waiver integrity' },
]

export function NoLeagueState() {
    const { push } = useRouter()
    return (
        <PromptFrame
            cardMaxWidth={520}
            containerStyle={Platform.OS === 'web' ? styles.containerWeb : null}
            cardStyle={styles.card}
        >
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
        </PromptFrame>
    )
}

const styles = StyleSheet.create({
    containerWeb: {
        backgroundImage: webBackgrounds.noLeague,
    } as WebOnlyViewStyle,
    card: {
        paddingHorizontal: spacing['4xl'],
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
