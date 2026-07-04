import { View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import type { LeagueStatus } from '@/types/database'

function standingsIntroCopy(status?: LeagueStatus) {
    switch (status) {
        case 'setup':
            return {
                title: 'Everyone starts 0-0',
                copy: 'The full league table is visible before the draft so every manager can see the field from day one.',
            }
        case 'drafting':
            return {
                title: 'Standings stay open during the draft',
                copy: 'Rosters are still forming, but every team remains listed here with records ready for scoring.',
            }
        case 'offseason':
            return {
                title: 'Offseason table is ready',
                copy: 'Review last cycle, inspect teams, and keep the next season visible before games return.',
            }
        case 'playoffs':
            return {
                title: 'Playoff standings',
                copy: 'Regular-season records stay intact while bracket play decides the title.',
            }
        case 'archived':
            return {
                title: 'Final standings',
                copy: 'This table is preserved for league history.',
            }
        default:
            return {
                title: 'Live standings',
                copy: 'Records and point totals update as regular-season games finalize.',
            }
    }
}

export function standingsPointMetricLabels(showPa: boolean, showMaxPf: boolean) {
    const labels = ['PF']
    if (showMaxPf) labels.push('MAX PF')
    if (showPa) labels.push('PA')
    return labels
}

function standingsTeamCountLabel(teamCount: number, loading?: boolean) {
    return loading ? 'Teams loading' : `${teamCount} teams`
}

function standingsPointStatLabel(status: LeagueStatus | undefined, showPa: boolean, showMaxPf: boolean, loading?: boolean) {
    const metricLabel = standingsPointMetricLabels(showPa, showMaxPf).join(' / ')
    if (loading) return `${metricLabel} loading`
    switch (status) {
        case 'active':
            return `${metricLabel} live`
        case 'playoffs':
            return `${metricLabel} locked`
        case 'archived':
            return `${metricLabel} final`
        case 'offseason':
            return `${metricLabel} preserved`
        default:
            return `${metricLabel} ready`
    }
}

function standingsIntroStats(status: LeagueStatus | undefined, showPa: boolean, showMaxPf: boolean, loading?: boolean): [string, string] {
    if (loading) return ['Records loading', standingsPointStatLabel(status, showPa, showMaxPf, true)]
    switch (status) {
        case 'active':
            return ['Records updating', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'playoffs':
            return ['Records locked', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'archived':
            return ['Final records', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'offseason':
            return ['Records preserved', standingsPointStatLabel(status, showPa, showMaxPf)]
        default:
            return ['Records initialized', standingsPointStatLabel(status, showPa, showMaxPf)]
    }
}

function StandingsIntro({
    teamCount,
    status,
    showPa,
    showMaxPf,
    onOpenBracket,
    loading,
}: {
    teamCount: number
    status?: LeagueStatus
    showPa: boolean
    showMaxPf: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    const intro = standingsIntroCopy(status)
    const [recordStat, pointsStat] = standingsIntroStats(status, showPa, showMaxPf, loading)
    const teamStat = standingsTeamCountLabel(teamCount, loading)
    const showBracketAction = status === 'playoffs' && onOpenBracket
    const accessibilityLabel = `${intro.title}. ${intro.copy} ${teamStat}. ${recordStat}. ${pointsStat}.`

    return (
        <View
            style={styles.standingsIntro}
            role="group"
            aria-label={accessibilityLabel}
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <View>
                <Text style={styles.standingsIntroTitle} role="heading" aria-level={2}>{intro.title}</Text>
                <Text style={styles.standingsIntroCopy}>{intro.copy}</Text>
            </View>
            <View style={styles.standingsIntroStats}>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{teamStat}</Text>
                </View>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{recordStat}</Text>
                </View>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{pointsStat}</Text>
                </View>
            </View>
            {showBracketAction ? (
                <Pressable
                    style={styles.standingsIntroAction}
                    onPress={onOpenBracket}
                    role="button"
                    aria-label="Open playoff bracket"
                    accessibilityRole="button"
                    accessibilityLabel="Open playoff bracket"
                >
                    <Text style={styles.standingsIntroActionText}>Open Bracket</Text>
                </Pressable>
            ) : null}
        </View>
    )
}

function CompactPlayoffBracketAction({ onOpenBracket, embedded = false }: { onOpenBracket?: () => void; embedded?: boolean }) {
    if (!onOpenBracket) return null
    return (
        <Pressable
            style={[styles.standingsCompactAction, embedded && styles.standingsCompactActionEmbedded]}
            onPress={onOpenBracket}
            role="button"
            aria-label="Open playoff bracket"
            accessibilityRole="button"
            accessibilityLabel="Open playoff bracket"
        >
            <Text style={styles.standingsIntroActionText}>Open Playoff Bracket</Text>
        </Pressable>
    )
}

function CompactStandingsIntro({
    teamCount,
    status,
    showPa,
    showMaxPf,
    onOpenBracket,
    loading,
}: {
    teamCount: number
    status?: LeagueStatus
    showPa: boolean
    showMaxPf: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    const intro = standingsIntroCopy(status)
    const [recordStat, pointsStat] = standingsIntroStats(status, showPa, showMaxPf, loading)
    const teamStat = standingsTeamCountLabel(teamCount, loading)
    const accessibilityLabel = `${intro.title}. ${intro.copy} ${teamStat}. ${recordStat}. ${pointsStat}.`

    return (
        <View
            style={styles.standingsCompactIntro}
            role="group"
            aria-label={accessibilityLabel}
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <View style={styles.standingsCompactLine}>
                <View style={styles.standingsCompactIntroText}>
                    <Text style={styles.standingsCompactIntroTitle} numberOfLines={1} role="heading" aria-level={2}>{intro.title}</Text>
                    <Text style={styles.standingsCompactIntroCopy} numberOfLines={1}>{intro.copy}</Text>
                </View>
                <View style={styles.standingsCompactStats}>
                    {[teamStat, recordStat, pointsStat].map((stat) => (
                        <View key={stat} style={styles.standingsCompactStat}>
                            <Text style={styles.standingsCompactStatText} numberOfLines={1}>{stat}</Text>
                        </View>
                    ))}
                </View>
            </View>
            {status === 'playoffs' ? <CompactPlayoffBracketAction onOpenBracket={onOpenBracket} embedded /> : null}
        </View>
    )
}

export function StandingsContextHeader({
    showMaxPf,
    showPa,
    teamCount,
    leagueStatus,
    compact,
    onOpenBracket,
    loading,
}: {
    showMaxPf: boolean
    showPa: boolean
    teamCount: number
    leagueStatus?: LeagueStatus
    compact: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    return (
        <>
            {compact ? (
                <CompactStandingsIntro
                    teamCount={teamCount}
                    status={leagueStatus}
                    showPa={showPa}
                    showMaxPf={showMaxPf}
                    onOpenBracket={onOpenBracket}
                    loading={loading}
                />
            ) : (
                <StandingsIntro
                    teamCount={teamCount}
                    status={leagueStatus}
                    showPa={showPa}
                    showMaxPf={showMaxPf}
                    onOpenBracket={onOpenBracket}
                    loading={loading}
                />
            )}
        </>
    )
}

const styles = StyleSheet.create({
    standingsIntro: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
        gap: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    standingsIntroTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    standingsIntroCopy: {
        fontSize: fontSize.sm,
        color: colors.textSecondary,
        lineHeight: 18,
    },
    standingsIntroStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    standingsIntroStat: {
        minHeight: 32,
        paddingHorizontal: spacing.lg,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
    },
    standingsIntroStatText: {
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
    standingsIntroAction: {
        minHeight: 44,
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    standingsIntroActionText: {
        color: colors.textWhite,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    standingsCompactIntro: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        paddingBottom: spacing.xs,
        gap: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    // Title/copy and the info chips flow in one wrapping line so the compact
    // intro costs one line where space allows (two on 360px phones).
    standingsCompactLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: spacing.sm,
        rowGap: spacing.xs,
    },
    standingsCompactIntroText: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    standingsCompactIntroTitle: {
        color: colors.textPrimary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    standingsCompactIntroCopy: {
        flex: 1,
        minWidth: 0,
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
    },
    standingsCompactStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    standingsCompactStat: {
        minHeight: 24,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
    },
    standingsCompactStatText: {
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
    standingsCompactAction: {
        minHeight: 44,
        marginHorizontal: spacing.md,
        marginTop: spacing.sm,
        marginBottom: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    standingsCompactActionEmbedded: {
        marginHorizontal: 0,
        marginTop: 0,
        marginBottom: 0,
    },
})
