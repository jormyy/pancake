import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { colors, palette, fontFamily, fontWeight, radii, spacing, webOverlays } from '@/constants/tokens'
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
}: {
    games: NBAGameRow[]
    myTeamSet: Set<string>
    compact?: boolean
}) {
    if (games.length === 0) return null

    const sorted = sortGames(games)

    return (
        <View style={[styles.container, compact && styles.containerCompact]}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={[styles.scroll, compact && styles.scrollCompact]}
            >
                {sorted.map((g, index) => {
                    const isLive = g.status === 'InProgress'
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
                                isLive && styles.cardLive,
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
                                    !isFinal && !isLive && styles.scoreHidden,
                                    myAway && (isFinal || isLive) && styles.scoreHighlight,
                                ]}>
                                    {isFinal || isLive ? g.away_score : '·'}
                                </Text>
                            </View>
                            {/* Home */}
                            <View style={styles.teamRow}>
                                <Text style={[styles.tricode, myHome && styles.tricodeHighlight]}>
                                    {g.home_team}
                                </Text>
                                <Text style={[
                                    styles.score,
                                    !isFinal && !isLive && styles.scoreHidden,
                                    myHome && (isFinal || isLive) && styles.scoreHighlight,
                                ]}>
                                    {isFinal || isLive ? g.home_score : '·'}
                                </Text>
                            </View>
                            {/* Status */}
                            <View style={styles.statusRow}>
                                {isLive && <LivePulse color={colors.primary} size={5} />}
                                <Text style={[
                                    styles.status,
                                    isLive && styles.statusLive,
                                    isFinal && styles.statusFinal,
                                ]}>
                                    {statusLabel(g)}
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
        backgroundColor: palette.espresso,
        borderBottomWidth: 3,
        borderBottomColor: colors.primary,
    },
    containerCompact: {
        borderBottomWidth: 2,
    },
    scroll: {
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
        gap: spacing.md,
    },
    scrollCompact: {
        paddingHorizontal: spacing.lg,
        paddingVertical: 6,
        gap: spacing.sm,
    },
    card: {
        width: 90,
        backgroundColor: palette.coffee,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 10,
        paddingVertical: 9,
        gap: 2,
        overflow: 'hidden' as const,
        borderWidth: 1,
        borderColor: webOverlays.scoreboardBorder,
    },
    cardCompact: {
        width: 78,
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 1,
    },
    cardLive: {
        borderColor: colors.primary,
        borderWidth: 1.5,
        boxShadow: webOverlays.liveGlow,
    },
    cardFinal: {
        opacity: 0.6,
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
        fontSize: 11,
        fontWeight: fontWeight.bold,
        color: palette.oatmilk,
        letterSpacing: 0.4,
    },
    tricodeHighlight: {
        color: palette.maple200,
        fontWeight: fontWeight.extrabold,
    },
    score: {
        fontSize: 13,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: palette.maple200,
        minWidth: 24,
        textAlign: 'right',
    },
    scoreHidden: {
        color: webOverlays.scoreboardHidden,
        fontSize: 11,
    },
    scoreHighlight: {
        color: palette.maple100,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        marginTop: 4,
    },
    status: {
        fontSize: 9,
        fontWeight: fontWeight.bold,
        color: webOverlays.scoreboardMuted,
        textAlign: 'center',
        letterSpacing: 0.3,
    },
    statusLive: {
        color: palette.maple200,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.5,
    },
    statusFinal: {
        color: webOverlays.scoreboardFaint,
    },
})
