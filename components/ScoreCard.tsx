import { Platform, View, Text, StyleSheet } from 'react-native'
import { Matchup } from '@/lib/scoring'
import { alpha, borderWidth, colors, fontSize, fontWeight, radii, shadows, spacing, textStyles, uiColors } from '@/constants/tokens'
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
    const compactEdgeLabel = margin === 0 ? 'Tied' : `${iWinning ? 'You' : 'Opp'} +${formatPoints(margin)}`

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

    const firstWeek = matchup.roundStartWeek ?? matchup.weekNumber
    const lastWeek = matchup.roundEndWeek ?? matchup.weekNumber
    const weekLabel = firstWeek === lastWeek ? `Week ${firstWeek}` : `Weeks ${firstWeek}–${lastWeek}`

    return (
        <View style={[styles.card, compact && styles.cardCompact]}>
            <View style={[styles.header, compact && styles.headerCompact]}>
                <Text
                    style={styles.week}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                    accessibilityLabel={`${weekLabel} matchup`}
                >
                    {weekLabel.toUpperCase()}
                </Text>
                <View style={styles.headerRule} />
                <View style={[styles.statusBadge, compact && styles.statusBadgeCompact, { backgroundColor: alpha(statusTint, 0.1), borderColor: alpha(statusTint, 0.31) }]}>
                    <Text style={[styles.statusText, compact && styles.statusTextCompact, { color: statusText }]}>{statusLabel}</Text>
                </View>
            </View>

            <View style={[styles.scores, compact && styles.scoresCompact]}>
                <View style={styles.side}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact]}>{matchup.myTeamName}</Text>
                    <Text style={[styles.record, compact && styles.compactMeta]}>{matchup.myWins}–{matchup.myLosses}</Text>
                    <Text style={[styles.score, compact && styles.scoreCompact, iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.myPoints)}
                    </Text>
                </View>

                <View style={styles.vsDivider}>
                    <Text style={styles.vs}>vs</Text>
                </View>

                <View style={[styles.side, styles.sideRight]}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact, styles.teamNameRight]}>{matchup.opponentTeamName}</Text>
                    <Text style={[styles.record, compact && styles.compactMeta, styles.textRight]}>{matchup.opponentWins}–{matchup.opponentLosses}</Text>
                    <Text style={[styles.score, compact && styles.scoreCompact, oppWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.opponentPoints)}
                    </Text>
                </View>
            </View>

            <View style={[styles.edgeWrap, compact && styles.edgeWrapCompact]}>
                <View style={[styles.edgeTrack, compact && styles.edgeTrackCompact]}>
                    <View style={[styles.edgeMine, { width: `${myShare}%` }]} />
                    <View style={styles.edgeOpponent} />
                </View>
                <Text style={styles.edgeCenter} numberOfLines={1} ellipsizeMode="clip">{compact ? compactEdgeLabel : edgeLabel}</Text>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        marginTop: spacing.md,
        marginBottom: spacing.sm,
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: borderWidth.medium,
        borderColor: colors.borderLight,
        overflow: 'hidden' as const,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.md } : {}),
    },
    cardCompact: {
        marginTop: spacing.xs,
        marginBottom: spacing.xs,
        borderRadius: radii.xl,
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.md,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgSubtle,
    },
    headerCompact: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
    },
    week: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        letterSpacing: textStyles.sectionLabel.letterSpacing,
    },
    headerRule: {
        flex: 1,
        height: borderWidth.thin,
        backgroundColor: colors.separator,
    },
    statusBadge: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        borderWidth: borderWidth.thin,
    },
    statusBadgeCompact: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xxs,
    },
    statusText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        letterSpacing: textStyles.tableHeader.letterSpacing,
    },
    statusTextCompact: {
        fontSize: fontSize['2xs'],
    },

    scores: {
        flexDirection: 'row',
        alignItems: 'stretch',
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
    },
    scoresCompact: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: spacing.xxs,
    },
    side: { flex: 1, minWidth: 0, gap: spacing.xxs },
    sideRight: { alignItems: 'flex-end' },
    teamName: {
        flexGrow: 1,
        width: '100%',
        fontSize: fontSize['2sm'],
        color: colors.textMuted,
        fontWeight: fontWeight.semibold,
    },
    teamNameCompact: {
        fontSize: fontSize.xs,
        lineHeight: textStyles.sectionLabel.lineHeight,
    },
    teamNameRight: { textAlign: 'right' },
    compactMeta: {
        fontSize: fontSize['2xs'],
        lineHeight: textStyles.tableHeader.lineHeight,
        color: colors.textPlaceholder,
        fontWeight: fontWeight.semibold,
    },
    textRight: { textAlign: 'right' },
    record: {
        fontSize: fontSize.xs,
        color: colors.textPlaceholder,
        fontWeight: fontWeight.semibold,
        marginTop: spacing.xxs,
    },
    score: { ...textStyles.hero },
    scoreCompact: { ...textStyles.compactScore },
    scoreWin: {
        color: colors.textPrimary,
    },
    scoreLose: {
        color: colors.textMuted,
    },

    vsDivider: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        alignSelf: 'center',
    },
    vs: {
        fontSize: fontSize['2xs'],
        color: colors.textPlaceholder,
        fontWeight: fontWeight.extrabold,
        letterSpacing: textStyles.sectionLabel.letterSpacing,
    },
    edgeWrap: {
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.md,
        gap: spacing.sm,
    },
    edgeWrapCompact: {
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
        gap: spacing.xxs,
    },
    edgeTrack: {
        height: spacing.sm,
        flexDirection: 'row',
        overflow: 'hidden' as const,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
        borderWidth: borderWidth.thin,
        borderColor: colors.borderLight,
    },
    edgeTrackCompact: {
        height: spacing.xs,
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
    edgeCenter: {
        flex: 1,
        minWidth: 0,
        textAlign: 'center',
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
})
