import { useMemo, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ListHeader } from '@/components/ui/ListHeader'
import { usePageMetrics } from '@/components/ui'
import { ScreenStatusScrollView } from '@/components/ui/ScreenStatusOverlay'
import { colors, layout, spacing, textStyles } from '@/constants/tokens'
import type { HistoryStanding, SeasonHistory } from '@/lib/league-history'

function seasonLabel(year: number) {
    return `${year - 1}–${String(year).slice(-2)}`
}

function recordLabel(team: HistoryStanding) {
    return `${team.wins}-${team.losses}-${team.ties}`
}

export function LeagueHistory({ seasons, onRefresh, refreshing = false }: {
    seasons: SeasonHistory[]
    onRefresh: () => void
    refreshing?: boolean
}) {
    const { padX } = usePageMetrics()
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const ordered = useMemo(() => [...seasons].sort((a, b) => b.year - a.year), [seasons])
    const selected = ordered.find(season => season.id === selectedId)

    if (!ordered.length) {
        return <EmptyState icon="emoji-events" message="No completed seasons yet." description="Your league's completed Pancake seasons appear here." />
    }

    return (
        <ScreenStatusScrollView
            contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
            <View style={styles.column}>
                {selected ? (
                    <>
                        <Button title="All seasons" icon="arrow-back" variant="ghost" onPress={() => setSelectedId(null)} style={styles.back} />
                        <Card elevated="none" style={styles.summary}>
                            <Text style={textStyles.sectionLabel}>Completed season</Text>
                            <Text role="heading" accessibilityRole="header" style={textStyles.pageTitle}>{seasonLabel(selected.year)}</Text>
                            {selected.champion ? <Text style={textStyles.rowTitle}>{selected.champion.teamName} · Champion</Text> : null}
                            <View style={styles.stats}>
                                <View style={styles.stat}>
                                    <Text style={textStyles.pageTitle}>{selected.stats.teams}</Text>
                                    <Text style={textStyles.meta}>Teams</Text>
                                </View>
                                <View style={styles.stat}>
                                    <Text style={textStyles.pageTitle}>{selected.stats.games}</Text>
                                    <Text style={textStyles.meta}>Regular-season matchups</Text>
                                </View>
                                <View style={styles.stat}>
                                    <Text style={textStyles.pageTitle}>{selected.stats.pointsFor.toFixed(1)}</Text>
                                    <Text style={textStyles.meta}>Regular-season points</Text>
                                </View>
                            </View>
                        </Card>
                        <View style={styles.copy}>
                            <Text role="heading" accessibilityRole="header" style={textStyles.rowTitle}>Final standings</Text>
                            <Text style={textStyles.meta}>Record and points are from the regular season.</Text>
                            <Text style={textStyles.meta}>Teams out in the same round follow regular-season order.</Text>
                        </View>
                        <Card padding="none" elevated="none" style={styles.table}>
                            <ListHeader style={styles.row}>
                                <Text style={[textStyles.tableHeader, styles.rank]} accessibilityLabel="Final place">#</Text>
                                <Text style={[textStyles.tableHeader, styles.team]}>Team</Text>
                                <Text style={[textStyles.tableHeader, styles.record]} accessibilityLabel="Regular-season record">W-L-T</Text>
                                <Text style={[textStyles.tableHeader, styles.points]} accessibilityLabel="Points for">PF</Text>
                                <Text style={[textStyles.tableHeader, styles.points]} accessibilityLabel="Points against">PA</Text>
                            </ListHeader>
                            <View role="list" aria-label="Final season standings">
                                {selected.standings.map(team => (
                                    <View key={team.memberId} role="listitem"
                                        accessibilityLabel={`Place ${team.finalRank}, ${team.teamName}, ${team.playoffResult}, record ${recordLabel(team)}, ${team.pointsFor.toFixed(1)} points for, ${team.pointsAgainst.toFixed(1)} points against`}
                                        style={[styles.row, styles.standing, team.finalRank === 1 && styles.champion]}>
                                        <Text style={[textStyles.tableCell, styles.rank]}>{team.finalRank}</Text>
                                        <View style={styles.team}>
                                            <Text style={textStyles.rowTitle}>{team.teamName}</Text>
                                            <Text style={textStyles.meta}>{team.playoffResult}</Text>
                                        </View>
                                        <Text style={[textStyles.tableCell, styles.record]}>{recordLabel(team)}</Text>
                                        <Text style={[textStyles.tableCell, styles.points]}>{team.pointsFor.toFixed(1)}</Text>
                                        <Text style={[textStyles.tableCell, styles.points]}>{team.pointsAgainst.toFixed(1)}</Text>
                                    </View>
                                ))}
                            </View>
                        </Card>
                    </>
                ) : (
                    <>
                        <View style={styles.copy}>
                            <Text role="heading" accessibilityRole="header" style={textStyles.pageTitle}>League history</Text>
                            <Text style={textStyles.meta}>Completed Pancake seasons</Text>
                        </View>
                        {ordered.map(season => (
                            <Card key={season.id} elevated="none" onPress={() => setSelectedId(season.id)}
                                accessibilityLabel={`Open ${seasonLabel(season.year)} season${season.champion ? `, champion ${season.champion.teamName}` : ''}`}>
                                <View style={styles.seasonRow}>
                                    <View style={styles.seasonCopy}>
                                        <Text style={textStyles.pageTitle}>{seasonLabel(season.year)}</Text>
                                        <Text style={textStyles.body}>{season.champion ? `${season.champion.teamName} · Champion` : 'Season complete'}</Text>
                                        <Text style={textStyles.meta}>{season.stats.teams} teams · {season.stats.games} regular-season matchups</Text>
                                    </View>
                                    <Text style={textStyles.rowTitle} accessibilityElementsHidden>›</Text>
                                </View>
                            </Card>
                        ))}
                    </>
                )}
            </View>
        </ScreenStatusScrollView>
    )
}

const styles = StyleSheet.create({
    content: { paddingTop: spacing.md, paddingBottom: spacing['3xl'] },
    column: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', gap: spacing.md },
    back: { alignSelf: 'flex-start' },
    summary: { gap: spacing.sm },
    copy: { gap: spacing.xs },
    stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, paddingTop: spacing.sm },
    stat: { flexGrow: 1, minWidth: 64, gap: spacing.xs },
    table: { overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, gap: spacing.xs },
    standing: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    champion: { backgroundColor: colors.primaryLight },
    rank: { width: 20, textAlign: 'center' },
    team: { flex: 1, minWidth: 0, gap: spacing.xs },
    record: { width: 44, textAlign: 'right' },
    points: { width: 52, textAlign: 'right' },
    seasonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    seasonCopy: { flex: 1, minWidth: 0, gap: spacing.sm },
})
