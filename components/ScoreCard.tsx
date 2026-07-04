import { View, Text, StyleSheet } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { alpha, colors, palette } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'
import { MotionView } from '@/components/Motion'

export function ScoreCard({ matchup, compact = false }: { matchup: Matchup; compact?: boolean }) {
    const myPts = matchup.myPoints ?? 0
    const oppPts = matchup.opponentPoints ?? 0
    // Neither side is "winning" on a tie (incl. the 0–0 week start), so a tie
    // shows both scores neutrally rather than crowning the opponent.
    const iWinning = myPts > oppPts
    const oppWinning = oppPts > myPts

    let statusLabel = 'In Progress'
    let statusTint: string = palette.maple500
    let statusText: string = colors.primaryDark
    if (matchup.isFinalized) {
        if (matchup.iWon === true) {
            statusLabel = 'Win'
            statusTint = palette.green500
            statusText = colors.successDark
        } else if (matchup.iWon === false) {
            statusLabel = 'Loss'
            statusTint = palette.red500
            statusText = colors.dangerDark
        } else {
            statusLabel = 'Tie'
            statusTint = palette.latte
            statusText = colors.textMuted
        }
    }

    return (
        <MotionView style={[styles.card, compact && styles.cardCompact]} preset="rise" delay={80}>
            {/* Header bar */}
            <View style={[styles.header, compact && styles.headerCompact]}>
                <Text
                    style={styles.week}
                    role="heading"
                    aria-level={1}
                    accessibilityRole="header"
                    accessibilityLabel={`Week ${matchup.weekNumber} matchup`}
                >
                    WEEK {matchup.weekNumber}
                </Text>
                <View style={styles.headerRule} />
                <View style={[styles.statusBadge, { backgroundColor: alpha(statusTint, 0.1), borderColor: alpha(statusTint, 0.31) }]}>
                    <Text style={[styles.statusText, { color: statusText }]}>{statusLabel}</Text>
                </View>
            </View>

            {/* Scores */}
            <View style={[styles.scores, compact && styles.scoresCompact]}>
                {/* My side */}
                <View style={styles.side}>
                    <Text style={styles.teamName} numberOfLines={1}>{matchup.myTeamName}</Text>
                    {matchup.myUsername ? (
                        <Text style={styles.username} numberOfLines={1}>{matchup.myUsername}</Text>
                    ) : null}
                    <Text style={[styles.score, compact && styles.scoreCompact, iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.myPoints)}
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
                    <Text style={[styles.score, compact && styles.scoreCompact, oppWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.opponentPoints)}
                    </Text>
                    <Text style={[styles.record, { textAlign: 'right' }]}>
                        {matchup.opponentWins}–{matchup.opponentLosses}
                    </Text>
                </View>
            </View>
        </MotionView>
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
    cardCompact: {
        marginVertical: 6,
        borderRadius: 12,
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
    headerCompact: {
        paddingHorizontal: 14,
        paddingTop: 8,
        paddingBottom: 8,
    },
    week: {
        fontSize: 10,
        fontWeight: '800',
        color: colors.primaryDark,
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
    scoresCompact: {
        paddingHorizontal: 14,
        paddingVertical: 10,
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
    scoreCompact: {
        fontSize: 30,
        lineHeight: 35,
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
