import { Badge } from '@/components/ui/Badge'
import type { ReactNode } from 'react'
import { Platform, View, Text, StyleSheet } from 'react-native'
import type { Matchup } from '@/lib/scoring'
import { alpha, componentTokens, borderWidth, colors, fontSize, fontWeight, radii, shadows, spacing, textStyles, uiColors } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'

export function ScoreCard({ matchup, compact = false, children }: { matchup: Matchup; compact?: boolean; children?: ReactNode }) {
    const myPts = matchup.myPoints ?? 0
    const oppPts = matchup.opponentPoints ?? 0
    const iWinning = myPts > oppPts
    const oppWinning = oppPts > myPts

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
                <Badge size="outlined" variant="solid" label={statusLabel} color={alpha(statusTint, 0.1)} textColor={statusText}
                    style={[compact && componentTokens.badge.outlinedCompact, { borderColor: alpha(statusTint, 0.31) }]}
                    textStyle={[{ letterSpacing: componentTokens.badge.scoreLetterSpacing }, compact && componentTokens.badge.countLabel]}
                />
            </View>

            <View style={[styles.scores, compact && styles.scoresCompact]}>
                <View style={styles.side}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact]}>{matchup.myTeamName}</Text>
                    <Text style={styles.record}>{`${matchup.myWins ?? 0}-${matchup.myLosses ?? 0}`}</Text>
                    <Text style={[styles.score, compact && styles.scoreCompact, iWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.myPoints)}
                    </Text>
                </View>

                <View style={[styles.side, styles.sideRight]}>
                    <Text style={[styles.teamName, compact && styles.teamNameCompact, styles.teamNameRight]}>{matchup.opponentTeamName}</Text>
                    <Text style={styles.record}>{`${matchup.opponentWins ?? 0}-${matchup.opponentLosses ?? 0}`}</Text>
                    <Text style={[styles.score, compact && styles.scoreCompact, oppWinning ? styles.scoreWin : styles.scoreLose]}>
                        {formatPoints(matchup.opponentPoints)}
                    </Text>
                </View>
            </View>
            {children}
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
        borderWidth: 0,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.none } : {}),
        marginTop: spacing.xs,
        marginBottom: spacing.xs,
        borderRadius: radii.xl,
    },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.md,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgSubtle,
    },
    headerCompact: {
        borderBottomWidth: 0,
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
    },
    week: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        letterSpacing: textStyles.sectionLabel.letterSpacing,
    },
    scores: {
        flexDirection: 'row',
        alignItems: 'stretch',
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
    },
    scoresCompact: {
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.xxs,
        paddingBottom: spacing.md,
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
        marginTop: spacing.none,
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
})
