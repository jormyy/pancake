import { View, Text, StyleSheet } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { colors, palette } from '@/constants/tokens'

export function ScoreCard({ matchup }: { matchup: Matchup }) {
    const fmt = (n: number | null) => (n != null ? n.toFixed(1) : '—')
    const myPts = matchup.myPoints ?? 0
    const oppPts = matchup.opponentPoints ?? 0
    const iWinning = myPts > oppPts

    let statusLabel = 'In Progress'
    let statusColor: string = colors.primary
    if (matchup.isFinalized) {
        statusLabel = matchup.iWon ? 'Win' : 'Loss'
        statusColor = matchup.iWon ? colors.success : colors.danger
    }

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Text style={styles.week}>Week {matchup.weekNumber}</Text>
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
                    <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
            </View>
            <View style={styles.scores}>
                <View style={styles.side}>
                    <Text style={styles.team} numberOfLines={1}>{matchup.myTeamName}</Text>
                    {matchup.myUsername ? <Text style={styles.username} numberOfLines={1}>{matchup.myUsername}</Text> : null}
                    <Text style={[styles.score, iWinning && styles.winningScore]}>{fmt(matchup.myPoints)}</Text>
                    <Text style={styles.record}>{matchup.myWins}-{matchup.myLosses}</Text>
                </View>
                <Text style={styles.vs}>vs</Text>
                <View style={[styles.side, styles.sideRight]}>
                    <Text style={styles.team} numberOfLines={1}>{matchup.opponentTeamName}</Text>
                    {matchup.opponentUsername ? <Text style={[styles.username, { textAlign: 'right' }]} numberOfLines={1}>{matchup.opponentUsername}</Text> : null}
                    <Text style={[styles.score, !iWinning && styles.winningScore]}>{fmt(matchup.opponentPoints)}</Text>
                    <Text style={[styles.record, { textAlign: 'right' }]}>{matchup.opponentWins}-{matchup.opponentLosses}</Text>
                </View>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        margin: 16,
        backgroundColor: colors.bgCard,
        borderRadius: 16,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: 20,
        gap: 16,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    week: { fontSize: 13, fontWeight: '700', color: colors.textPlaceholder, letterSpacing: 0.5 },
    statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderCurve: 'continuous' as const },
    statusText: { fontSize: 12, fontWeight: '700' },
    scores: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    side: { flex: 1, gap: 4 },
    sideRight: { alignItems: 'flex-end' },
    team: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },
    username: { fontSize: 11, color: colors.textPlaceholder, fontWeight: '400', marginTop: 1 },
    record: { fontSize: 12, color: colors.textPlaceholder, fontWeight: '600', marginTop: 2 },
    score: { fontSize: 36, fontWeight: '800', color: palette.gray500 },
    winningScore: { color: colors.textPrimary },
    vs: { fontSize: 14, color: palette.gray500, fontWeight: '600', paddingHorizontal: 4 },
})
