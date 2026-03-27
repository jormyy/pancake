import { View, Text, StyleSheet } from 'react-native'

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
        backgroundColor: '#FFF7ED',
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        padding: 16,
        gap: 10,
    },
    title: { fontSize: 13, fontWeight: '700', color: '#C2410C', textTransform: 'uppercase', letterSpacing: 0.5 },
    row: { flexDirection: 'row', alignItems: 'center' },
    stat: { flex: 1, alignItems: 'center', gap: 4 },
    divider: { width: 1, height: 36, backgroundColor: '#FED7AA' },
    statValue: { fontSize: 24, fontWeight: '800', color: '#F97316' },
    statLabel: { fontSize: 11, fontWeight: '600', color: '#9A3412' },
})
