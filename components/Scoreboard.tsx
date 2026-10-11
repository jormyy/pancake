import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { useEdgeFade } from '@/components/ui/useEdgeFade'
import { colors, fontFamily, fontSize, fontWeight, radii, scoreboardColors, spacing } from '@/constants/tokens'
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
                    const isLive = isInProgress && freshness === 'fresh'
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
                                {isLive && <LivePulse color={colors.primary} size={5} />}
                                <Text numberOfLines={1} accessibilityLabel={freshness === 'fresh' ? undefined : freshness === 'failed' ? 'Refresh failed. Saved scores.' : `${freshness === 'offline' ? 'Offline' : 'Updating'}. Saved scores.`} style={[
                                    styles.status,
                                    freshness !== 'fresh' && styles.statusSaved,
                                    isLive && styles.statusLive,
                                    isFinal && styles.statusFinal,
                                ]}>
                                    {freshness === 'fresh' ? statusLabel(g) : freshness === 'offline' ? 'Offline' : freshness === 'failed' ? 'Failed' : 'Updating'}
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
        borderBottomWidth: 3,
        borderBottomColor: colors.primary,
    },
    containerCompact: {
        borderBottomWidth: 2,
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
        width: 96,
        backgroundColor: scoreboardColors.card,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 10,
        paddingVertical: 9,
        gap: 2,
        overflow: 'hidden' as const,
        borderWidth: 1,
        borderColor: scoreboardColors.border,
    },
    cardCompact: {
        width: 88,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 1,
    },
    cardLive: {
        borderColor: colors.primary,
        borderWidth: 1.5,
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
        height: 2,
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
        letterSpacing: 0.4,
    },
    tricodeHighlight: {
        color: scoreboardColors.accent,
        fontWeight: fontWeight.extrabold,
    },
    score: {
        fontSize: 13,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: scoreboardColors.accent,
        minWidth: 24,
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
        gap: 3,
        marginTop: 4,
    },
    status: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: scoreboardColors.textMuted,
        textAlign: 'center',
        letterSpacing: 0.3,
    },
    statusSaved: {
        color: scoreboardColors.textMuted,
    },
    statusLive: {
        color: scoreboardColors.accent,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.5,
    },
    statusFinal: {
        color: scoreboardColors.textMuted,
    },
})
