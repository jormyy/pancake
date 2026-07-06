import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'

type Props = {
    avgFantasyPoints: number
    gamesCount: number
}

export function FantasyCard({ avgFantasyPoints, gamesCount }: Props) {
    return (
        <View style={styles.card}>
            <Text style={styles.title}>Fantasy Points</Text>
            <View style={styles.row}>
                <View style={styles.stat}>
                    <Text style={styles.statValue}>{avgFantasyPoints.toFixed(1)}</Text>
                    <Text style={styles.statLabel}>AVG / GAME</Text>
                </View>
                <View style={styles.divider} />
                <View style={styles.stat}>
                    <Text style={styles.statValue}>{gamesCount}</Text>
                    <Text style={styles.statLabel}>GAMES</Text>
                </View>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.primaryLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: 10,
    },
    title: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark, textTransform: 'uppercase', letterSpacing: 0.5 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing['5xl'] },
    stat: { alignItems: 'center', gap: spacing.xs, minWidth: 88 },
    divider: { width: 1, height: 36, backgroundColor: colors.primaryBorder },
    statValue: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    statLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: uiColors.brandTextStrong },
})
