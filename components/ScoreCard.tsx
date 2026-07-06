import { Platform, View, Text, StyleSheet } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { alpha, colors, fontFamily, fontSize, fontWeight, radii, shadows, uiColors } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'

function compactOwnerRecord(username: string | null | undefined, wins: number, losses: number): string {
    const firstName = username?.trim().split(/\s+/)[0]
    const owner = firstName ? firstName.slice(0, 6) : null
    return [owner, `${wins}-${losses}`].filter(Boolean).join(' ')
}

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
    const compactEdgeLabel = margin === 0 ? 'Tied' : `${iWinning ? 'You' : 'Opp'} +${formatPoints(margin)}`
    const myCompactMeta = compactOwnerRecord(matchup.myUsername, matchup.myWins, matchup.myLosses)
    const opponentCompactMeta = compactOwnerRecord(matchup.opponentUsername, matchup.opponentWins, matchup.opponentLosses)

    let statusLabel = 'In Progress'
    let statusTint: string = uiColors.brandAccent
    let statusText: string = colors.primaryDark
    if (matchup.isFinalized) {
        if (matchup.iWon === true) {
            statusLabel = 'Win'
            statusTint = uiColors.accentSuccess
            statusText = colors.successDark
        } else if (matchup.iWon === false) {
            statusLabel = 'Loss'
            statusTint = uiColors.accentDanger
            statusText = colors.dangerDark
        } else {
            statusLabel = 'Tie'
            statusTint = uiColors.neutralTint
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
                <View style={[styles.statusBadge, compact && styles.statusBadgeCompact, { backgroundColor: alpha(statusTint, 0.1), borderColor: alpha(statusTint, 0.31) }]}>
                    <Text style={[styles.statusText, compact && styles.statusTextCompact, { color: statusText }]}>{statusLabel}</Text>
                </View>
            </View>

            <View style={[styles.scores, compact && styles.scoresCompact]}>
                <View style={styles.side}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact]} numberOfLines={1} ellipsizeMode="clip">{matchup.myTeamName}</Text>
                    {compact ? (
                        <Text style={styles.compactMeta} numberOfLines={1} ellipsizeMode="clip">{myCompactMeta}</Text>
                    ) : matchup.myUsername ? (
                        <Text style={styles.username} numberOfLines={1} ellipsizeMode="clip">{matchup.myUsername}</Text>
                    ) : null}
                    <Text style={[styles.score, compact && styles.scoreCompact, iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.myPoints)}
                    </Text>
                    {!compact ? <Text style={styles.record}>{matchup.myWins}–{matchup.myLosses}</Text> : null}
                </View>

                <View style={styles.vsDivider}>
                    <Text style={styles.vs}>vs</Text>
                </View>

                <View style={[styles.side, styles.sideRight]}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact]} numberOfLines={1} ellipsizeMode="clip">{matchup.opponentTeamName}</Text>
                    {compact ? (
                        <Text style={[styles.compactMeta, styles.compactMetaRight]} numberOfLines={1} ellipsizeMode="clip">{opponentCompactMeta}</Text>
                    ) : matchup.opponentUsername ? (
                        <Text style={[styles.username, { textAlign: 'right' }]} numberOfLines={1} ellipsizeMode="clip">
                            {matchup.opponentUsername}
                        </Text>
                    ) : null}
                    <Text style={[styles.score, compact && styles.scoreCompact, oppWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.opponentPoints)}
                    </Text>
                    {!compact ? <Text style={[styles.record, { textAlign: 'right' }]}>
                        {matchup.opponentWins}–{matchup.opponentLosses}
                    </Text> : null}
                </View>
            </View>

            <View style={[styles.edgeWrap, compact && styles.edgeWrapCompact]}>
                <View style={[styles.edgeTrack, compact && styles.edgeTrackCompact]}>
                    <View style={[styles.edgeMine, { width: `${myShare}%` }]} />
                    <View style={styles.edgeOpponent} />
                </View>
                <View style={styles.edgeLabels}>
                    <Text style={[styles.edgeText, iWinning && styles.edgeTextStrong]} numberOfLines={1} ellipsizeMode="clip">
                        {formatPoints(matchup.myPoints)}
                    </Text>
                    <Text style={styles.edgeCenter} numberOfLines={1} ellipsizeMode="clip">{compact ? compactEdgeLabel : edgeLabel}</Text>
                    <Text style={[styles.edgeText, oppWinning && styles.edgeTextStrong]} numberOfLines={1} ellipsizeMode="clip">
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
        marginVertical: 3,
        borderRadius: 12,
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingTop: 8,
        paddingBottom: 7,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgSubtle,
    },
    headerCompact: {
        paddingHorizontal: 14,
        paddingTop: 5,
        paddingBottom: 5,
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
    statusBadgeCompact: {
        paddingHorizontal: 9,
        paddingVertical: 2,
    },
    statusText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        letterSpacing: 0.2,
    },
    statusTextCompact: {
        fontSize: fontSize['2xs'],
    },

    scores: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingTop: 10,
        paddingBottom: 7,
    },
    scoresCompact: {
        paddingHorizontal: 14,
        paddingTop: 6,
        paddingBottom: 3,
    },
    side: { flex: 1, gap: 2 },
    sideRight: { alignItems: 'flex-end' },
    teamName: {
        fontSize: fontSize['2sm'],
        color: colors.textMuted,
        fontWeight: fontWeight.semibold,
    },
    teamNameCompact: {
        fontSize: fontSize.xs,
        lineHeight: 13,
    },
    username: {
        fontSize: fontSize['2xs'],
        color: colors.textPlaceholder,
        fontWeight: fontWeight.regular,
    },
    compactMeta: {
        fontSize: fontSize['2xs'],
        lineHeight: 12,
        color: colors.textPlaceholder,
        fontWeight: fontWeight.semibold,
    },
    compactMetaRight: {
        textAlign: 'right',
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
        fontSize: 27,
        lineHeight: 31,
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
        paddingBottom: 9,
        gap: 6,
    },
    edgeWrapCompact: {
        paddingHorizontal: 14,
        paddingBottom: 7,
        gap: 3,
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
    edgeTrackCompact: {
        height: 5,
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
