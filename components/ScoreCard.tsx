import { Platform, View, Text, StyleSheet } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { alpha, colors, palette, fontFamily, fontSize, fontWeight, radii, shadows } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'

export function ScoreCard({ matchup, compact = false }: { matchup: Matchup; compact?: boolean }) {
    const myPts = matchup.myPoints ?? 0
    const oppPts = matchup.opponentPoints ?? 0
    const iWinning = myPts > oppPts
    const oppWinning = oppPts > myPts
    const scoreTotal = myPts + oppPts
    const myShare = scoreTotal > 0 ? Math.max(8, Math.min(92, (myPts / scoreTotal) * 100)) : 50
    const margin = Math.abs(myPts - oppPts)
    const edgeLabel = margin === 0
        ? 'Tied'
        : `${iWinning ? matchup.myTeamName : matchup.opponentTeamName} +${formatPoints(margin)}`

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
        <View style={[styles.card, compact && styles.cardCompact]}>
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

            <View style={[styles.scores, compact && styles.scoresCompact]}>
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

                <View style={styles.vsDivider}>
                    <Text style={styles.vs}>vs</Text>
                </View>

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

            <View style={styles.edgeWrap}>
                <View style={styles.edgeTrack}>
                    <View style={[styles.edgeMine, { width: `${myShare}%` }]} />
                    <View style={styles.edgeOpponent} />
                </View>
                <View style={styles.edgeLabels}>
                    <Text style={[styles.edgeText, iWinning && styles.edgeTextStrong]} numberOfLines={1}>
                        {formatPoints(matchup.myPoints)}
                    </Text>
                    <Text style={styles.edgeCenter} numberOfLines={1}>{edgeLabel}</Text>
                    <Text style={[styles.edgeText, oppWinning && styles.edgeTextStrong]} numberOfLines={1}>
                        {formatPoints(matchup.opponentPoints)}
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
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.borderLight,
        overflow: 'hidden' as const,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.md } : {}),
    },
    cardCompact: {
        marginVertical: 4,
        borderRadius: 12,
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingTop: 10,
        paddingBottom: 9,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgSubtle,
    },
    headerCompact: {
        paddingHorizontal: 14,
        paddingTop: 7,
        paddingBottom: 7,
    },
    week: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        letterSpacing: 1.1,
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
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        letterSpacing: 0.2,
    },

    scores: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingTop: 14,
        paddingBottom: 10,
    },
    scoresCompact: {
        paddingHorizontal: 14,
        paddingTop: 10,
        paddingBottom: 7,
    },
    side: { flex: 1, gap: 2 },
    sideRight: { alignItems: 'flex-end' },
    teamName: {
        fontSize: fontSize['2sm'],
        color: colors.textMuted,
        fontWeight: fontWeight.semibold,
    },
    username: {
        fontSize: fontSize['2xs'],
        color: colors.textPlaceholder,
        fontWeight: fontWeight.regular,
    },
    record: {
        fontSize: fontSize.xs,
        color: colors.textPlaceholder,
        fontWeight: fontWeight.semibold,
        marginTop: 2,
    },
    score: {
        fontSize: 38,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
        lineHeight: 44,
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
        justifyContent: 'center',
        paddingHorizontal: 12,
        alignSelf: 'center',
    },
    vs: {
        fontSize: fontSize['2xs'],
        color: colors.textPlaceholder,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1,
    },
    edgeWrap: {
        paddingHorizontal: 18,
        paddingBottom: 13,
        gap: 6,
    },
    edgeTrack: {
        height: 6,
        flexDirection: 'row',
        overflow: 'hidden' as const,
        borderRadius: 999,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    edgeMine: {
        height: '100%',
        backgroundColor: colors.primary,
    },
    edgeOpponent: {
        flex: 1,
        height: '100%',
        backgroundColor: colors.bgMuted,
    },
    edgeLabels: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    edgeText: {
        width: 58,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
    },
    edgeTextStrong: {
        color: colors.primaryDark,
    },
    edgeCenter: {
        flex: 1,
        minWidth: 0,
        textAlign: 'center',
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
})
