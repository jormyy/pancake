import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { useMemo, useState } from 'react'
import { WeekDay } from '@/lib/lineup'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

const ALL_TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']

export function ScheduleGrid({
    weekDays,
    selectedTeams,
    onToggleTeam,
}: {
    weekDays: WeekDay[]
    selectedTeams: string[]
    onToggleTeam: (team: string) => void
}) {
    const [expanded, setExpanded] = useState(false)
    const today = useMemo(() => {
        const d = new Date()
        return d.toISOString().split('T')[0]
    }, [])

    const futureDays = useMemo(() => weekDays.filter((d) => d.date >= today), [weekDays, today])

    // Build team → days played map
    const teamDays = useMemo(() => {
        const map = new Map<string, string[]>()
        for (const team of ALL_TEAMS) {
            map.set(team, [])
        }
        for (const day of futureDays) {
            for (const team of day.playingTeams) {
                const arr = map.get(team)
                if (arr) arr.push(day.date)
            }
        }
        return map
    }, [futureDays])

    // Sort teams: selected first, then by games count desc, then alphabetically
    const sortedTeams = useMemo(() => {
        const selected = new Set(selectedTeams)
        return [...ALL_TEAMS].sort((a, b) => {
            const sa = selected.has(a) ? 0 : 1
            const sb = selected.has(b) ? 0 : 1
            if (sa !== sb) return sa - sb
            const ga = teamDays.get(a)?.length ?? 0
            const gb = teamDays.get(b)?.length ?? 0
            if (ga !== gb) return gb - ga
            return a.localeCompare(b)
        })
    }, [teamDays, selectedTeams])

    // Count games per day
    const dayGameCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const day of futureDays) {
            counts.set(day.date, day.playingTeams.length)
        }
        return counts
    }, [futureDays])

    if (futureDays.length === 0) return null

    const visibleTeams = expanded ? sortedTeams : sortedTeams.slice(0, 10)

    return (
        <View style={styles.container}>
            <Pressable style={styles.header} onPress={() => setExpanded((v) => !v)}>
                <Text style={styles.headerTitle}>Schedule Grid</Text>
                <Text style={styles.headerArrow}>{expanded ? '▲' : '▼'}</Text>
            </Pressable>

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                    {/* Column headers: day labels + game count */}
                    <View style={styles.headerRow}>
                        <View style={styles.teamLabelCol}>
                            <Text style={styles.cornerText}>Team</Text>
                        </View>
                        {futureDays.map((day) => (
                            <View key={day.date} style={styles.dayCol}>
                                <Text style={styles.dayLabelText}>{day.dayLabel}</Text>
                                <Text style={styles.dayCountText}>
                                    {dayGameCounts.get(day.date) ?? 0}
                                </Text>
                            </View>
                        ))}
                    </View>

                    {/* Team rows */}
                    {visibleTeams.map((team) => {
                        const games = teamDays.get(team) ?? []
                        const isSelected = selectedTeams.includes(team)
                        return (
                            <Pressable
                                key={team}
                                style={[styles.teamRow, isSelected && styles.teamRowSelected]}
                                onPress={() => onToggleTeam(team)}
                            >
                                <View style={styles.teamLabelCol}>
                                    <Text style={[styles.teamLabelText, isSelected && styles.teamLabelTextSelected]}>
                                        {team}
                                    </Text>
                                    <Text style={styles.teamGamesText}>
                                        {games.length}G
                                    </Text>
                                </View>
                                {futureDays.map((day) => {
                                    const plays = games.includes(day.date)
                                    return (
                                        <View key={day.date} style={styles.cellCol}>
                                            <View style={[styles.cell, plays && styles.cellActive]} />
                                        </View>
                                    )
                                })}
                            </Pressable>
                        )
                    })}

                    {!expanded && sortedTeams.length > 10 && (
                        <Pressable style={styles.showMoreRow} onPress={() => setExpanded(true)}>
                            <Text style={styles.showMoreText}>
                                Show all {sortedTeams.length} teams
                            </Text>
                        </Pressable>
                    )}
                </View>
            </ScrollView>
        </View>
    )
}

const CELL_SIZE = 18
const TEAM_LABEL_WIDTH = 52

const styles = StyleSheet.create({
    container: {
        marginHorizontal: spacing.xl,
        marginBottom: spacing.lg,
        backgroundColor: colors.bgCard,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    headerArrow: { fontSize: fontSize.xs, color: colors.textMuted },

    headerRow: {
        flexDirection: 'row',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.xs,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    teamLabelCol: {
        width: TEAM_LABEL_WIDTH,
        alignItems: 'flex-end',
        paddingRight: spacing.sm,
        justifyContent: 'center',
    },
    cornerText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },

    dayCol: {
        width: CELL_SIZE + 4,
        alignItems: 'center',
    },
    dayLabelText: { fontSize: 9, fontWeight: fontWeight.bold, color: colors.textMuted, textTransform: 'uppercase' as const },
    dayCountText: { fontSize: 9, color: colors.textPlaceholder },

    teamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        paddingHorizontal: spacing.xs,
    },
    teamRowSelected: {
        backgroundColor: colors.primaryLight,
    },
    teamLabelText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamLabelTextSelected: { color: colors.primary, fontWeight: fontWeight.bold },
    teamGamesText: { fontSize: 8, color: colors.textPlaceholder },

    cellCol: {
        width: CELL_SIZE + 4,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 2,
    },
    cell: {
        width: CELL_SIZE,
        height: CELL_SIZE,
        borderRadius: 4,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    cellActive: {
        backgroundColor: colors.primary,
    },

    showMoreRow: {
        paddingVertical: spacing.sm,
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
    },
    showMoreText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.primary },
})
