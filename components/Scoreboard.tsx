import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { NBAGameRow } from '@/lib/games'

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
}: {
    games: NBAGameRow[]
    myTeamSet: Set<string>  // tricodes of teams your roster players are on
}) {
    if (games.length === 0) return null

    const sorted = sortGames(games)

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scroll}
            >
                {sorted.map((g) => {
                    const isLive = g.status === 'InProgress'
                    const isFinal = g.status === 'Final'
                    const myAway = myTeamSet.has(g.away_team)
                    const myHome = myTeamSet.has(g.home_team)
                    return (
                        <View key={g.id} style={[styles.card, isLive && styles.cardLive]}>
                            {/* Away team */}
                            <View style={styles.teamRow}>
                                <Text style={[styles.tricode, myAway && styles.tricodeHighlight]}>
                                    {g.away_team}
                                </Text>
                                <Text style={[
                                    styles.score,
                                    !isFinal && !isLive && styles.scoreHidden,
                                ]}>
                                    {isFinal || isLive ? g.away_score : '—'}
                                </Text>
                            </View>
                            {/* Home team */}
                            <View style={styles.teamRow}>
                                <Text style={[styles.tricode, myHome && styles.tricodeHighlight]}>
                                    {g.home_team}
                                </Text>
                                <Text style={[
                                    styles.score,
                                    !isFinal && !isLive && styles.scoreHidden,
                                ]}>
                                    {isFinal || isLive ? g.home_score : '—'}
                                </Text>
                            </View>
                            {/* Status */}
                            <Text style={[styles.status, isLive && styles.statusLive]}>
                                {statusLabel(g)}
                            </Text>
                        </View>
                    )
                })}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    scroll: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    card: {
        width: 92,
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        gap: 3,
    },
    cardLive: {
        backgroundColor: palette.orange50,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    teamRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    tricode: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    tricodeHighlight: {
        color: colors.primary,
    },
    score: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        minWidth: 22,
        textAlign: 'right',
    },
    scoreHidden: {
        color: colors.textMuted,
    },
    status: {
        fontSize: 10,
        fontWeight: fontWeight.medium,
        color: colors.textMuted,
        marginTop: 2,
        textAlign: 'center',
    },
    statusLive: {
        color: colors.primary,
        fontWeight: fontWeight.semibold,
    },
})
