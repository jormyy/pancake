import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { compareStandingsRows, type StandingRow } from '@/lib/scoring'
import { colors, fontSize, fontWeight, layout, radii, spacing, srOnly, table, textStyles } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { usePageMetrics } from '@/components/ui'
import type { LeagueStatus } from '@/types/database'

type StandingsSortKey = 'wins' | 'pf' | 'maxPf' | 'pa'
type PressableState = { hovered?: boolean; pressed?: boolean }

const STANDINGS_LIST_ID = 'league-standings-results'
const RANK_W = 28
const RECORD_W = 64
const POINTS_W = 64
const RECORD_W_NARROW = 44
const POINTS_W_NARROW = 52

const STANDINGS_SORT_LABELS: Record<StandingsSortKey, string> = {
    wins: 'wins',
    pf: 'points for',
    maxPf: 'maximum possible points for',
    pa: 'points against',
}

function sortDirectionLabel(direction: 'asc' | 'desc') {
    return direction === 'asc' ? 'ascending' : 'descending'
}

function defaultSortDirection(key: StandingsSortKey): 'asc' | 'desc' {
    return key === 'pa' ? 'asc' : 'desc'
}

function standingsSortAccessibilityLabel(key: StandingsSortKey, sortBy: StandingsSortKey, sortDir: 'asc' | 'desc') {
    const label = STANDINGS_SORT_LABELS[key]
    if (sortBy === key) {
        const nextDir = sortDir === 'asc' ? 'desc' : 'asc'
        return `Sort standings by ${label}. Currently sorted ${sortDirectionLabel(sortDir)}. Activate to sort ${sortDirectionLabel(nextDir)}.`
    }
    return `Sort standings by ${label}. Activates ${sortDirectionLabel(defaultSortDirection(key))} order.`
}

function standingsSortControlsAccessibilityLabel(sortBy: StandingsSortKey, sortDir: 'asc' | 'desc') {
    return `Standings sort controls, sorted by ${STANDINGS_SORT_LABELS[sortBy]} ${sortDirectionLabel(sortDir)}`
}

function standingsRowAccessibilityLabel(item: StandingRow, index: number, isMe: boolean, showMaxPf: boolean, showPa: boolean) {
    const parts = [
        `Rank ${index + 1}`,
        `${item.teamName}${isMe ? ', your team' : ''}`,
        `record ${countLabel(item.wins, 'win')}, ${item.losses} ${item.losses === 1 ? 'loss' : 'losses'}, ${countLabel(item.ties, 'tie')}`,
        `${item.pointsFor.toFixed(1)} points for`,
    ]
    if (showMaxPf) parts.push(`${item.maxPointsFor.toFixed(1)} maximum possible points for`)
    if (showPa) parts.push(`${item.pointsAgainst.toFixed(1)} points against`)
    parts.push('Open roster')
    return parts.join(', ')
}

function standingsListAccessibilityLabel(status: LeagueStatus | undefined, count: number, sortBy: StandingsSortKey, sortDir: 'asc' | 'desc') {
    const phase =
        status === 'setup'
            ? 'Pre-draft standings'
            : status === 'drafting'
              ? 'Drafting standings'
              : status === 'playoffs'
                ? 'Playoff standings'
                : status === 'offseason'
                  ? 'Offseason standings'
                  : status === 'archived'
                    ? 'Final standings'
                    : 'Regular season standings'
    return `${phase}, ${countLabel(count, 'team')}, sorted by ${STANDINGS_SORT_LABELS[sortBy]} ${sortDirectionLabel(sortDir)}`
}

function standingsRecordLabel(item: StandingRow, showTies: boolean) {
    return showTies ? `${item.wins}-${item.losses}-${item.ties}` : `${item.wins}-${item.losses}`
}

function StandingsRow({
    item,
    index,
    isMe,
    onPress,
    showMaxPf,
    showPa,
    showTies,
    narrow,
    padX,
}: {
    item: StandingRow
    index: number
    isMe: boolean
    onPress: () => void
    showMaxPf: boolean
    showPa: boolean
    showTies: boolean
    narrow: boolean
    padX: number
}) {
    const label = standingsRowAccessibilityLabel(item, index, isMe, showMaxPf, showPa)
    const cell = [styles.cell, isMe && tableStyles.textMe]
    const recordCol = { width: narrow ? RECORD_W_NARROW : RECORD_W }
    const pointsCol = { width: narrow ? POINTS_W_NARROW : POINTS_W }

    return (
        <Pressable
            style={({ hovered }: PressableState) => [
                styles.row,
                { paddingHorizontal: padX },
                isMe && tableStyles.rowMe,
                hovered && !isMe && styles.rowHover,
            ]}
            onPress={onPress}
            role="button"
            aria-label={label}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <Text style={[styles.rank, isMe && tableStyles.textMe]}>{index + 1}</Text>
            <View style={styles.teamWrap}>
                <Text style={[styles.teamName, isMe && tableStyles.textMe]} numberOfLines={1}>
                    {item.teamName}
                </Text>
                {isMe ? (
                    <View style={styles.youPill} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <Text style={styles.youText}>You</Text>
                    </View>
                ) : null}
            </View>
            <Text style={[cell, recordCol]} numberOfLines={1}>{standingsRecordLabel(item, showTies)}</Text>
            <Text style={[cell, pointsCol]} numberOfLines={1}>{item.pointsFor.toFixed(1)}</Text>
            {showMaxPf ? <Text style={[cell, pointsCol]} numberOfLines={1}>{item.maxPointsFor.toFixed(1)}</Text> : null}
            {showPa ? <Text style={[cell, pointsCol]} numberOfLines={1}>{item.pointsAgainst.toFixed(1)}</Text> : null}
        </Pressable>
    )
}

function SortHeader({
    sortKey,
    label,
    sortBy,
    sortDir,
    onSort,
    style,
}: {
    sortKey: StandingsSortKey
    label: string
    sortBy: StandingsSortKey
    sortDir: 'asc' | 'desc'
    onSort: (key: StandingsSortKey) => void
    style: { width: number }
}) {
    const active = sortBy === sortKey
    const accessibilityLabel = standingsSortAccessibilityLabel(sortKey, sortBy, sortDir)
    return (
        <Pressable
            style={[styles.headerCell, styles.headerCellNumeric, style]}
            onPress={() => onSort(sortKey)}
            hitSlop={6}
            role="button"
            aria-label={accessibilityLabel}
            aria-controls={STANDINGS_LIST_ID}
            aria-pressed={active}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ selected: active }}
        >
            <Text style={[textStyles.tableHeader, active && styles.headerActive]} numberOfLines={1}>
                {label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
            </Text>
        </Pressable>
    )
}

function StandingsHeader({
    sortBy,
    sortDir,
    onSort,
    showMaxPf,
    showPa,
    narrow,
    padX,
}: {
    sortBy: StandingsSortKey
    sortDir: 'asc' | 'desc'
    onSort: (key: StandingsSortKey) => void
    showMaxPf: boolean
    showPa: boolean
    narrow: boolean
    padX: number
}) {
    const sortControlsLabel = standingsSortControlsAccessibilityLabel(sortBy, sortDir)
    const sortProps = { sortBy, sortDir, onSort }
    const recordCol = { width: narrow ? RECORD_W_NARROW : RECORD_W }
    const pointsCol = { width: narrow ? POINTS_W_NARROW : POINTS_W }
    return (
        <Fragment>
            <View
                style={srOnly}
                role="status"
                aria-label={sortControlsLabel}
                aria-live="polite"
                accessibilityLabel={sortControlsLabel}
                accessibilityLiveRegion="polite"
            >
                <Text>{sortControlsLabel}</Text>
            </View>
            <View
                style={[styles.header, { paddingHorizontal: padX }]}
                role="toolbar"
                aria-label={sortControlsLabel}
                accessibilityLabel={sortControlsLabel}
            >
                <Text style={[textStyles.tableHeader, styles.rank]} accessibilityLabel="Rank">#</Text>
                <Text style={[textStyles.tableHeader, styles.teamWrap]} accessibilityLabel="Team name">Team</Text>
                <SortHeader sortKey="wins" label="W-L" style={recordCol} {...sortProps} />
                <SortHeader sortKey="pf" label="PF" style={pointsCol} {...sortProps} />
                {showMaxPf ? <SortHeader sortKey="maxPf" label="Max PF" style={pointsCol} {...sortProps} /> : null}
                {showPa ? <SortHeader sortKey="pa" label="PA" style={pointsCol} {...sortProps} /> : null}
            </View>
        </Fragment>
    )
}

// Mirrors the server bracket seeding convention (supabase/migrations/
// 20260628000008_edge_atomic_playoffs.sql): leagues with 10+ teams send 6 to
// the bracket, smaller leagues send the top 4. There is no client-visible
// playoff team-count setting, so the cutoff is derived from league size.
function playoffTeamCount(teamCount: number) {
    return teamCount >= 10 ? 6 : 4
}

function PlayoffCutLine({ teamCount, padX }: { teamCount: number; padX: number }) {
    const label = `Playoff line: the top ${teamCount} teams qualify for the playoffs`
    return (
        <View
            style={[styles.playoffCutRow, { paddingHorizontal: padX }]}
            role="separator"
            aria-label={label}
            accessibilityRole="text"
            accessibilityLabel={label}
        >
            <View style={styles.playoffCutRule} />
            <Text style={styles.playoffCutLabel}>Playoff line</Text>
            <View style={styles.playoffCutRule} />
        </View>
    )
}

export function StandingsTable({
    standings,
    leagueStatus,
    loading = false,
    myMemberId,
    onSelectTeam,
}: {
    standings: StandingRow[]
    leagueStatus?: LeagueStatus
    loading?: boolean
    myMemberId?: string
    onSelectTeam: (memberId: string, teamName: string) => void
    onOpenBracket?: () => void
}) {
    const [sortBy, setSortBy] = useState<StandingsSortKey>('wins')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
    const { padX, usableWidth } = usePageMetrics()
    // Columns give way to the team name as the screen narrows: Max PF goes
    // first, then the columns tighten, and the smallest phones drop PA.
    const showMaxPf = usableWidth >= 520
    const narrow = usableWidth < 440
    const showPa = usableWidth >= 340
    const showTies = standings.some((row) => row.ties > 0)

    useEffect(() => {
        if ((sortBy !== 'maxPf' || showMaxPf) && (sortBy !== 'pa' || showPa)) return
        setSortBy('pf')
        setSortDir(defaultSortDirection('pf'))
    }, [showMaxPf, showPa, sortBy])

    const sorted = useMemo(() => {
        return [...standings].sort((a, b) => {
            let cmp = 0
            switch (sortBy) {
                case 'wins': cmp = -compareStandingsRows(a, b); break
                case 'pf': cmp = a.pointsFor - b.pointsFor; break
                case 'maxPf': cmp = a.maxPointsFor - b.maxPointsFor; break
                case 'pa': cmp = a.pointsAgainst - b.pointsAgainst; break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
    }, [standings, sortBy, sortDir])

    function handleSort(key: StandingsSortKey) {
        if (sortBy === key) {
            setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
        } else {
            setSortBy(key)
            setSortDir(defaultSortDirection(key))
        }
    }
    const listAccessibilityLabel = standingsListAccessibilityLabel(leagueStatus, sorted.length, sortBy, sortDir)
    // The cut line only makes sense while the table reads in seed order
    // (default wins-desc sort); any other sort scrambles seeding.
    const cutTeamCount = playoffTeamCount(sorted.length)
    const playoffCutIndex =
        sortBy === 'wins' && sortDir === 'desc' && sorted.length > cutTeamCount ? cutTeamCount : -1
    const emptyState = loading
        ? {
              message: 'Loading standings...',
              description: 'Fetching teams, records, and point totals.',
              accessibilityLabel: 'Loading standings. Fetching teams, records, and point totals.',
          }
        : {
              message: 'No league members yet.',
              description: 'Invite managers to fill the standings table before the draft.',
              accessibilityLabel: 'No league members yet. Invite managers to fill the standings table before the draft.',
          }
    // The header stays visible (and sortable) even before any team joins.
    const header = <StandingsHeader sortBy={sortBy} sortDir={sortDir} onSort={handleSort} showMaxPf={showMaxPf} showPa={showPa} narrow={narrow} padX={padX} />

    const tableBody = sorted.length ? (
        <View
            nativeID={STANDINGS_LIST_ID}
            role="list"
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            aria-label={listAccessibilityLabel}
            accessibilityRole="list"
            accessibilityLabel={listAccessibilityLabel}
            accessibilityState={{ busy: loading }}
            accessibilityLiveRegion="polite"
        >
            {sorted.map((item, index) => (
                <Fragment key={item.memberId}>
                    {index === playoffCutIndex ? (
                        <PlayoffCutLine teamCount={cutTeamCount} padX={padX} />
                    ) : index > 0 ? (
                        <ItemSeparator />
                    ) : null}
                    <View role="listitem" accessibilityRole="text">
                        <StandingsRow
                            item={item}
                            index={index}
                            isMe={item.memberId === myMemberId}
                            onPress={() => onSelectTeam(item.memberId, item.teamName)}
                            showMaxPf={showMaxPf}
                            showPa={showPa}
                            showTies={showTies}
                            narrow={narrow}
                            padX={padX}
                        />
                    </View>
                </Fragment>
            ))}
        </View>
    ) : (
        <View
            nativeID={STANDINGS_LIST_ID}
            role="status"
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            aria-label={emptyState.accessibilityLabel}
            accessibilityLabel={emptyState.accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <EmptyState message={emptyState.message} description={emptyState.description} fullScreen={false} />
        </View>
    )

    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.tableColumn}>
                {header}
                {tableBody}
            </View>
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: { paddingBottom: spacing['3xl'] },
    tableColumn: { width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center' },
    header: {
        minHeight: table.headerHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerCell: { minHeight: table.headerHeight, justifyContent: 'center' },
    headerCellNumeric: { alignItems: 'flex-end' },
    headerActive: { color: colors.primaryDark },
    row: {
        minHeight: table.rowHeightCompact,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    rowHover: { backgroundColor: colors.bgSubtle },
    rank: { width: RANK_W, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted, fontVariant: ['tabular-nums'] as const },
    teamWrap: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // Link-colored so every row (not just "You") reads as a tappable roster.
    teamName: { ...textStyles.rowTitle, flexShrink: 1, color: colors.primaryDark },
    youPill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
    },
    youText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.bold, color: colors.textWhite },
    cell: { ...textStyles.tableCell, textAlign: 'right' },
    playoffCutRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.xs,
    },
    playoffCutRule: { flex: 1, height: 1, backgroundColor: colors.border },
    playoffCutLabel: { ...textStyles.tableHeader },
})
