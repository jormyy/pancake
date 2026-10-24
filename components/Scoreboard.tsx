import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { useEdgeFade } from '@/components/ui/useEdgeFade'
import { borderWidth, colors, fontFamily, fontSize, fontWeight, layout, radii, scoreboardColors, spacing, textStyles } from '@/constants/tokens'
import { NBAGameRow } from '@/lib/games'
import { LivePulse, MotionView } from '@/components/Motion'

// Sort order: InProgress first, then Scheduled, then Final
function sortGames(games: NBAGameRow[]): NBAGameRow[] {
    const order = { InProgress: 0, Scheduled: 1, Final: 2 }
    return [...games].sort((a, b) => (order[a.status as keyof typeof order] ?? 1) - (order[b.status as keyof typeof order] ?? 1))
}

function statusLabel(game: NBAGameRow): string {
    if (game.game_status_text) return game.game_status_text
    if (game.status === 'InProgress') return 'Live'
    if (game.status === 'Final') return 'Final'
    return 'Scheduled'
}

export function Scoreboard({
    games,
    myTeamSet,
    compact = false,
    freshness = 'fresh',
    wrap = false,
}: {
    games: NBAGameRow[]
    myTeamSet: Set<string>
    compact?: boolean
    freshness?: 'fresh' | 'refreshing' | 'failed' | 'offline'
    wrap?: boolean
}) {
    const { fadeStyle, scrollProps } = useEdgeFade()
    if (games.length === 0) return freshness === 'failed'
        ? <Text style={styles.status}>Live scores unavailable.</Text>
        : null

    const sorted = sortGames(games)
    const scoresAvailable = freshness === 'fresh' || freshness === 'refreshing'

    return (
        <View style={[styles.container, compact && styles.containerCompact]}>
            <ScrollView
                horizontal={!wrap}
                scrollEnabled={!wrap}
                showsHorizontalScrollIndicator={false}
                style={wrap ? undefined : fadeStyle}
                {...scrollProps}
                contentContainerStyle={[styles.scroll, compact && styles.scrollCompact, wrap && styles.scrollWrap]}
            >
                {sorted.map((g, index) => {
                    const hasScore = g.status === 'InProgress' || g.status === 'Final'
                    const isInProgress = g.status === 'InProgress'
                    const isLive = isInProgress && scoresAvailable
                    const isFinal = g.status === 'Final'
                    const myAway = myTeamSet.has(g.away_team)
                    const myHome = myTeamSet.has(g.home_team)
                    return (
                        <MotionView
                            key={g.id}
                            delay={index * 35}
                            preset="pop"
                            style={[
                                styles.card,
                                compact && styles.cardCompact,
                                isInProgress && styles.cardLive,
                                isFinal && styles.cardFinal,
                            ]}
                        >
                            {isLive && <View style={styles.liveBar} />}
                            {/* Away */}
                            <View style={styles.teamRow}>
                                <Text style={[styles.tricode, myAway && styles.tricodeHighlight]}>
                                    {g.away_team}
                                </Text>
                                <Text style={[
                                    styles.score,
                                    !hasScore && styles.scoreHidden,
                                    myAway && hasScore && styles.scoreHighlight,
                                ]}>
                                    {hasScore ? g.away_score : '·'}
                                </Text>
                            </View>
                            {/* Home */}
                            <View style={styles.teamRow}>
                                <Text style={[styles.tricode, myHome && styles.tricodeHighlight]}>
                                    {g.home_team}
                                </Text>
                                <Text style={[
                                    styles.score,
                                    !hasScore && styles.scoreHidden,
                                    myHome && hasScore && styles.scoreHighlight,
                                ]}>
                                    {hasScore ? g.home_score : '·'}
                                </Text>
                            </View>
                            {/* Status */}
                            <View style={styles.statusRow}>
                                {isLive && <LivePulse color={colors.primary} size={spacing.sm} />}
                                <Text numberOfLines={1} accessibilityLabel={scoresAvailable ? undefined : freshness === 'failed' ? 'Refresh failed. Saved scores.' : 'Offline. Saved scores.'} style={[
                                    styles.status,
                                    isLive && styles.statusLive,
                                    isFinal && styles.statusFinal,
                                ]}>
                                    {scoresAvailable ? statusLabel(g) : freshness === 'offline' ? 'Offline' : 'Failed'}
                                </Text>
                            </View>
                        </MotionView>
                    )
                })}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: scoreboardColors.background,
        borderBottomWidth: borderWidth.accent,
        borderBottomColor: colors.primary,
    },
    containerCompact: {
        borderBottomWidth: borderWidth.strong,
    },
    scroll: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    scrollWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: spacing.lg,
    },
    scrollCompact: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    card: {
        width: layout.gameCard.width,
        backgroundColor: scoreboardColors.card,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        gap: spacing.xxs,
        overflow: 'hidden' as const,
        borderWidth: borderWidth.thin,
        borderColor: scoreboardColors.border,
    },
    cardCompact: {
        width: layout.gameCard.compactWidth,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        gap: spacing.xxs,
    },
    cardLive: {
        borderColor: colors.primary,
        borderWidth: borderWidth.medium,
        boxShadow: scoreboardColors.liveGlow,
    },
    cardFinal: {
        opacity: 0.85,
    },
    liveBar: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        height: borderWidth.strong,
        backgroundColor: colors.primary,
    },
    teamRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    tricode: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: scoreboardColors.textMuted,
        letterSpacing: textStyles.tableHeader.letterSpacing,
    },
    tricodeHighlight: {
        color: scoreboardColors.accent,
        fontWeight: fontWeight.extrabold,
    },
    score: {
        fontSize: fontSize.sm,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: scoreboardColors.accent,
        minWidth: layout.gameCard.scoreWidth,
        textAlign: 'right',
    },
    scoreHidden: {
        color: scoreboardColors.hidden,
        fontSize: fontSize.xs,
    },
    scoreHighlight: {
        color: scoreboardColors.accentSoft,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xxs,
        marginTop: spacing.xs,
    },
    status: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: scoreboardColors.textMuted,
        textAlign: 'center',
        letterSpacing: textStyles.tableHeader.letterSpacing,
    },
    statusLive: {
        color: scoreboardColors.accent,
        fontWeight: fontWeight.extrabold,
        letterSpacing: textStyles.tableHeader.letterSpacing,
    },
    statusFinal: {
        color: scoreboardColors.textMuted,
    },
})
