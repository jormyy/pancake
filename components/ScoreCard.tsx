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
            {/* Header bar */}
            <View style={styles.header}>
                <Text style={styles.week}>WEEK {matchup.weekNumber}</Text>
                <View style={styles.headerRule} />
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '1A', borderColor: statusColor + '50' }]}>
                    <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
            </View>

            {/* Scores */}
            <View style={styles.scores}>
                {/* My side */}
                <View style={styles.side}>
                    <Text style={styles.teamName} numberOfLines={1}>{matchup.myTeamName}</Text>
                    {matchup.myUsername ? (
                        <Text style={styles.username} numberOfLines={1}>{matchup.myUsername}</Text>
                    ) : null}
                    <Text style={[styles.score, iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {fmt(matchup.myPoints)}
                    </Text>
                    <Text style={styles.record}>{matchup.myWins}–{matchup.myLosses}</Text>
                </View>

                {/* VS divider */}
                <View style={styles.vsDivider}>
                    <View style={styles.vsDividerLine} />
                    <Text style={styles.vs}>vs</Text>
                    <View style={styles.vsDividerLine} />
                </View>

                {/* Opponent side */}
                <View style={[styles.side, styles.sideRight]}>
                    <Text style={styles.teamName} numberOfLines={1}>{matchup.opponentTeamName}</Text>
                    {matchup.opponentUsername ? (
                        <Text style={[styles.username, { textAlign: 'right' }]} numberOfLines={1}>
                            {matchup.opponentUsername}
                        </Text>
                    ) : null}
                    <Text style={[styles.score, !iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {fmt(matchup.opponentPoints)}
                    </Text>
                    <Text style={[styles.record, { textAlign: 'right' }]}>
                        {matchup.opponentWins}–{matchup.opponentLosses}
                    </Text>
                </View>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        marginHorizontal: 16,
        marginVertical: 10,
        backgroundColor: colors.bgCard,
        borderRadius: 16,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.borderLight,
        overflow: 'hidden' as const,
        boxShadow: '0 2px 12px rgba(44, 26, 14, 0.09)',
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingTop: 13,
        paddingBottom: 12,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgSubtle,
    },
    week: {
        fontSize: 10,
        fontWeight: '800',
        color: colors.primary,
        letterSpacing: 2,
    },
    headerRule: {
        flex: 1,
        height: 1,
        backgroundColor: colors.separator,
    },
    statusBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.2,
    },

    scores: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 18,
    },
    side: { flex: 1, gap: 2 },
    sideRight: { alignItems: 'flex-end' },
    teamName: {
        fontSize: 12,
        color: colors.textMuted,
        fontWeight: '600',
    },
    username: {
        fontSize: 10,
        color: colors.textPlaceholder,
        fontWeight: '400',
    },
    record: {
        fontSize: 11,
        color: colors.textPlaceholder,
        fontWeight: '600',
        marginTop: 2,
    },
    score: {
        fontSize: 40,
        fontWeight: '900',
        lineHeight: 48,
    },
    scoreWin: {
        color: colors.textPrimary,
    },
    scoreLose: {
        color: colors.textMuted,
    },

    vsDivider: {
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 14,
        alignSelf: 'center',
    },
    vsDividerLine: {
        width: 1,
        height: 22,
        backgroundColor: colors.separator,
    },
    vs: {
        fontSize: 10,
        color: colors.textPlaceholder,
        fontWeight: '800',
        letterSpacing: 1,
    },
})
