import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { compareStandingsRows, type StandingRow } from '@/lib/scoring'
import { colors, fontSize, fontWeight, radii, spacing, srOnly } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { StandingsContextHeader, standingsPointMetricLabels } from '@/components/league/LeagueStandingsIntro'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { useWebViewport } from '@/hooks/use-web-viewport'
import type { LeagueStatus } from '@/types/database'

type StandingsSortKey = 'wins' | 'pf' | 'maxPf' | 'pa'

const STANDINGS_LIST_ID = 'league-standings-results'

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

function standingsSortIsVisible(key: StandingsSortKey, showPa: boolean, showMaxPf: boolean) {
    if (key === 'pa') return showPa
    if (key === 'maxPf') return showMaxPf
    return true
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

function standingsRecordLabel(item: StandingRow) {
    return item.ties > 0 ? `${item.wins}-${item.losses}-${item.ties}` : `${item.wins}-${item.losses}`
}

function StandingsRow({
    item,
    index,
    isMe,
    onPress,
    showMaxPf,
    showPa,
    narrow,
}: {
    item: StandingRow
    index: number
    isMe: boolean
    onPress: () => void
    showMaxPf: boolean
    showPa: boolean
    narrow: boolean
}) {
    const label = standingsRowAccessibilityLabel(item, index, isMe, showMaxPf, showPa)

    return (
        <Pressable
            style={[styles.standingsRow, narrow && styles.standingsRowNarrow, isMe && tableStyles.rowMe]}
            onPress={onPress}
            role="button"
            aria-label={label}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            {narrow ? (
                <>
                    <Text style={[styles.standingsRank, styles.standingsRankNarrow, isMe && tableStyles.textMe]}>{index + 1}</Text>
                    <View style={[styles.standingsTeamWrap, styles.standingsTeamWrapNarrow]}>
                        <Text style={[styles.standingsTeamName, styles.standingsTeamNameNarrow, isMe && tableStyles.textMe]} numberOfLines={1}>
                            {item.teamName}
                        </Text>
                        {isMe ? (
                            <View style={styles.standingsYouPill} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                <Text style={styles.standingsYouText}>You</Text>
                            </View>
                        ) : null}
                    </View>
                    <Text style={[styles.standingsRecordNarrow, isMe && tableStyles.textMe]} numberOfLines={1}>
                        {standingsRecordLabel(item)}
                    </Text>
                    <Text style={[styles.standingsPtsNarrow, isMe && tableStyles.textMe]} numberOfLines={1}>
                        {item.pointsFor.toFixed(1)}
                    </Text>
                    <Text style={[styles.standingsPtsNarrow, isMe && tableStyles.textMe]} numberOfLines={1}>
                        {item.pointsAgainst.toFixed(1)}
                    </Text>
                </>
            ) : (
                <>
                    <Text style={[styles.standingsRank, isMe && tableStyles.textMe]}>{index + 1}</Text>
                    <View style={styles.standingsTeamWrap}>
                        <Text style={[styles.standingsTeamName, isMe && tableStyles.textMe]} numberOfLines={1}>
                            {item.teamName}
                        </Text>
                        {isMe ? (
                            <View style={styles.standingsYouPill} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                <Text style={styles.standingsYouText}>You</Text>
                            </View>
                        ) : null}
                    </View>
                    <Text style={[styles.standingsCell, isMe && tableStyles.textMe]}>{item.wins}</Text>
                    <Text style={[styles.standingsCell, isMe && tableStyles.textMe]}>{item.losses}</Text>
                    <Text style={[styles.standingsCell, isMe && tableStyles.textMe]}>{item.ties}</Text>
                    <Text style={[styles.standingsPts, isMe && tableStyles.textMe]}>{item.pointsFor.toFixed(1)}</Text>
                    {showMaxPf ? <Text style={[styles.standingsPts, isMe && tableStyles.textMe]}>{item.maxPointsFor.toFixed(1)}</Text> : null}
                    {showPa ? <Text style={[styles.standingsPts, isMe && tableStyles.textMe]}>{item.pointsAgainst.toFixed(1)}</Text> : null}
                </>
            )}
        </Pressable>
    )
}

const StandingsListHeader = ({
    sortBy,
    sortDir,
    onSort,
    showMaxPf,
    showPa,
    narrow,
}: {
    sortBy: StandingsSortKey
    sortDir: 'asc' | 'desc'
    onSort: (key: StandingsSortKey) => void
    showMaxPf: boolean
    showPa: boolean
    narrow: boolean
}) => {
    const arrow = (key: StandingsSortKey) =>
        sortBy === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
    const sortControlsLabel = standingsSortControlsAccessibilityLabel(sortBy, sortDir)
    // Narrow sort cells double as the mini-table's column headers, so they sit
    // right above the numbers they sort instead of forming a chip row.
    const narrowSortButton = (key: StandingsSortKey, label: string, colStyle: object) => (
        <Pressable
            key={key}
            style={[styles.standingsSortCellNarrow, colStyle]}
            onPress={() => onSort(key)}
            hitSlop={6}
            role="button"
            aria-label={standingsSortAccessibilityLabel(key, sortBy, sortDir)}
            aria-controls={STANDINGS_LIST_ID}
            aria-pressed={sortBy === key}
            accessibilityRole="button"
            accessibilityLabel={standingsSortAccessibilityLabel(key, sortBy, sortDir)}
            accessibilityState={{ selected: sortBy === key }}
        >
            <Text style={[tableStyles.headerText, sortBy === key && styles.standingsHeaderActive]}>{label}{arrow(key)}</Text>
        </Pressable>
    )

    if (narrow) {
        return (
            <Fragment>
                <View
                    style={styles.standingsSortLiveStatus}
                    role="status"
                    aria-label={sortControlsLabel}
                    aria-live="polite"
                    accessibilityLabel={sortControlsLabel}
                    accessibilityLiveRegion="polite"
                >
                    <Text>{sortControlsLabel}</Text>
                </View>
                <View
                    style={[styles.standingsRow, styles.standingsRowNarrow, styles.standingsHeader, styles.standingsHeaderNarrow]}
                    role="toolbar"
                    aria-label={sortControlsLabel}
                    accessibilityLabel={sortControlsLabel}
                >
                    <Text style={[styles.standingsRank, styles.standingsRankNarrow, tableStyles.headerText]} accessibilityLabel="Rank">#</Text>
                    <Text style={[styles.standingsTeam, tableStyles.headerText]} accessibilityLabel="Team name">Team</Text>
                    {narrowSortButton('wins', 'W-L', styles.standingsRecordColNarrow)}
                    {narrowSortButton('pf', 'PF', styles.standingsPtsColNarrow)}
                    {showPa ? narrowSortButton('pa', 'PA', styles.standingsPtsColNarrow) : null}
                </View>
            </Fragment>
        )
    }

    return (
        <Fragment>
            <View
                style={styles.standingsSortLiveStatus}
                role="status"
                aria-label={sortControlsLabel}
                aria-live="polite"
                accessibilityLabel={sortControlsLabel}
                accessibilityLiveRegion="polite"
            >
                <Text>{sortControlsLabel}</Text>
            </View>
            <View
                style={[styles.standingsRow, styles.standingsHeader]}
                role="toolbar"
                aria-label={sortControlsLabel}
                accessibilityLabel={sortControlsLabel}
            >
                <Text style={[styles.standingsRank, tableStyles.headerText]} accessibilityLabel="Rank">#</Text>
                <Text style={[styles.standingsTeam, tableStyles.headerText]} accessibilityLabel="Team name">Team</Text>
                <Pressable
                    style={[styles.standingsCell, styles.standingsSortCell]}
                    onPress={() => onSort('wins')}
                    hitSlop={6}
                    role="button"
                    aria-label={standingsSortAccessibilityLabel('wins', sortBy, sortDir)}
                    aria-controls={STANDINGS_LIST_ID}
                    aria-pressed={sortBy === 'wins'}
                    accessibilityRole="button"
                    accessibilityLabel={standingsSortAccessibilityLabel('wins', sortBy, sortDir)}
                    accessibilityState={{ selected: sortBy === 'wins' }}
                >
                    <Text style={[tableStyles.headerText, sortBy === 'wins' && styles.standingsHeaderActive]}>W{arrow('wins')}</Text>
                </Pressable>
                <Text style={[styles.standingsCell, tableStyles.headerText]} accessibilityLabel="Losses">L</Text>
                <Text style={[styles.standingsCell, tableStyles.headerText]} accessibilityLabel="Ties">T</Text>
                <Pressable
                    style={[styles.standingsPts, styles.standingsSortCell]}
                    onPress={() => onSort('pf')}
                    hitSlop={6}
                    role="button"
                    aria-label={standingsSortAccessibilityLabel('pf', sortBy, sortDir)}
                    aria-controls={STANDINGS_LIST_ID}
                    aria-pressed={sortBy === 'pf'}
                    accessibilityRole="button"
                    accessibilityLabel={standingsSortAccessibilityLabel('pf', sortBy, sortDir)}
                    accessibilityState={{ selected: sortBy === 'pf' }}
                >
                    <Text style={[tableStyles.headerText, sortBy === 'pf' && styles.standingsHeaderActive]}>PF{arrow('pf')}</Text>
                </Pressable>
                {showMaxPf ? (
                    <Pressable
                        style={[styles.standingsPts, styles.standingsSortCell]}
                        onPress={() => onSort('maxPf')}
                        hitSlop={6}
                        role="button"
                        aria-label={standingsSortAccessibilityLabel('maxPf', sortBy, sortDir)}
                        aria-controls={STANDINGS_LIST_ID}
                        aria-pressed={sortBy === 'maxPf'}
                        accessibilityRole="button"
                        accessibilityLabel={standingsSortAccessibilityLabel('maxPf', sortBy, sortDir)}
                        accessibilityState={{ selected: sortBy === 'maxPf' }}
                    >
                        <Text style={[tableStyles.headerText, sortBy === 'maxPf' && styles.standingsHeaderActive]}>MAX PF{arrow('maxPf')}</Text>
                    </Pressable>
                ) : null}
                {showPa ? (
                    <Pressable
                        style={[styles.standingsPts, styles.standingsSortCell]}
                        onPress={() => onSort('pa')}
                        hitSlop={6}
                        role="button"
                        aria-label={standingsSortAccessibilityLabel('pa', sortBy, sortDir)}
                        aria-controls={STANDINGS_LIST_ID}
                        aria-pressed={sortBy === 'pa'}
                        accessibilityRole="button"
                        accessibilityLabel={standingsSortAccessibilityLabel('pa', sortBy, sortDir)}
                        accessibilityState={{ selected: sortBy === 'pa' }}
                    >
                        <Text style={[tableStyles.headerText, sortBy === 'pa' && styles.standingsHeaderActive]}>PA{arrow('pa')}</Text>
                    </Pressable>
                ) : null}
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

function PlayoffCutLine({ teamCount }: { teamCount: number }) {
    const label = `Playoff line: the top ${teamCount} teams qualify for the playoffs`
    return (
        <View
            style={styles.playoffCutRow}
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

function standingsLegendCopy(status: LeagueStatus | undefined, showPa: boolean, showMaxPf: boolean) {
    const pointTermLabels: Record<string, string> = {
        PF: 'PF = Points For',
        'MAX PF': 'MAX PF = best possible score',
        PA: 'PA = Points Against',
    }
    const pointTerms = `${standingsPointMetricLabels(showPa, showMaxPf).map((label) => pointTermLabels[label]).join(' · ')}.`
    const recordCopy = (() => {
        switch (status) {
            case 'setup':
            case 'drafting':
                return 'Records will update once games are scored.'
            case 'playoffs':
                return 'Regular-season records stay locked while bracket play decides the champion.'
            case 'offseason':
                return 'Records are preserved from the completed season.'
            case 'archived':
                return 'Records are final for league history.'
            default:
                return 'Records update as regular-season games are scored.'
        }
    })()
    return `${pointTerms}\n${recordCopy}`
}

function StandingsTableHeader({
    sortBy,
    sortDir,
    onSort,
    showMaxPf,
    showPa,
    narrowRows,
    teamCount,
    leagueStatus,
    compact,
    onOpenBracket,
    loading,
}: {
    sortBy: StandingsSortKey
    sortDir: 'asc' | 'desc'
    onSort: (key: StandingsSortKey) => void
    showMaxPf: boolean
    showPa: boolean
    narrowRows: boolean
    teamCount: number
    leagueStatus?: LeagueStatus
    compact: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    return (
        <>
            <StandingsContextHeader
                showMaxPf={showMaxPf}
                showPa={showPa}
                teamCount={teamCount}
                leagueStatus={leagueStatus}
                compact={compact}
                onOpenBracket={onOpenBracket}
                loading={loading}
            />
            <StandingsListHeader sortBy={sortBy} sortDir={sortDir} onSort={onSort} showMaxPf={showMaxPf} showPa={showPa} narrow={narrowRows} />
        </>
    )
}

export function StandingsTable({
    standings,
    leagueStatus,
    loading = false,
    myMemberId,
    onSelectTeam,
    onOpenBracket,
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
    // Drop secondary point columns on narrow viewports so the Team name never
    // collapses (320px would otherwise squeeze it to a single letter).
    const { viewportWidth, compactLandscape } = useWebViewport()
    const compactPhoneLandscape = compactLandscape && viewportWidth < 700
    const narrowRows = viewportWidth < 440 || compactPhoneLandscape
    const compactHeader = compactLandscape || narrowRows
    // Narrow rows always carry the PA column in the mini-table; MAX PF only
    // rides in the full-width desktop table.
    const showPa = narrowRows || viewportWidth >= 440
    const showMaxPf = viewportWidth >= 560 && !narrowRows

    useEffect(() => {
        if (standingsSortIsVisible(sortBy, showPa, showMaxPf)) return
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
            setSortDir(key === 'pa' ? 'asc' : 'desc')
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
    const standingsHeader = (
        <StandingsTableHeader
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSort}
            showMaxPf={showMaxPf}
            showPa={showPa}
            narrowRows={narrowRows}
            teamCount={sorted.length}
            leagueStatus={leagueStatus}
            compact={compactHeader}
            onOpenBracket={onOpenBracket}
            loading={loading}
        />
    )
    const standingsList = (
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
                        <PlayoffCutLine teamCount={cutTeamCount} />
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
                            narrow={narrowRows}
                        />
                    </View>
                </Fragment>
            ))}
        </View>
    )

    return (
        <ScrollView
            style={styles.standingsScroll}
            contentContainerStyle={compactLandscape ? styles.standingsContentCompactLandscape : styles.standingsContent}
            removeClippedSubviews={false}
        >
            {sorted.length ? (
                <>
                    {compactLandscape ? standingsList : standingsHeader}
                    {compactLandscape ? standingsHeader : standingsList}
                    <Text style={styles.standingsLegend}>
                        {standingsLegendCopy(leagueStatus, showPa, showMaxPf)}
                    </Text>
                </>
            ) : (
                <>
                    <StandingsContextHeader
                        showMaxPf={showMaxPf}
                        showPa={showPa}
                        teamCount={0}
                        leagueStatus={leagueStatus}
                        compact={compactHeader}
                        onOpenBracket={onOpenBracket}
                        loading={loading}
                    />
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
                </>
            )}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    standingsRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    // Narrow rows stay a single aligned line: rank + name on the left, then
    // fixed-width numeric columns (W-L, PF, PA) — a mini-table, not pill chips.
    standingsRowNarrow: {
        paddingVertical: spacing.md,
        gap: spacing.sm,
    },
    standingsHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    standingsHeaderNarrow: { paddingVertical: 0 },
    standingsHeaderActive: { color: colors.primaryDark },
    standingsRank: { width: 24, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    standingsRankNarrow: { width: 22, fontSize: fontSize.sm },
    standingsTeam: { flex: 1, minWidth: 72, paddingRight: spacing.md, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    standingsTeamWrap: { flex: 1, minWidth: 72, paddingRight: spacing.md, alignItems: 'flex-start', justifyContent: 'center', gap: spacing.xxs },
    standingsTeamWrapNarrow: { minWidth: 0, paddingRight: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // Link-colored so every row (not just "You") reads as a tappable roster.
    standingsTeamName: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    standingsTeamNameNarrow: { fontSize: fontSize.sm },
    standingsRecordNarrow: {
        width: 52,
        textAlign: 'right',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
        fontVariant: ['tabular-nums'] as const,
    },
    standingsPtsNarrow: {
        width: 58,
        textAlign: 'right',
        fontSize: fontSize.sm,
        color: colors.textSecondary,
        fontVariant: ['tabular-nums'] as const,
    },
    standingsRecordColNarrow: { width: 52 },
    standingsPtsColNarrow: { width: 58 },
    standingsYouPill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
    },
    standingsYouText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textWhite },
    standingsCell: { width: 44, textAlign: 'center', fontSize: fontSize.md, color: colors.textSecondary },
    standingsPts: { width: 64, textAlign: 'center', fontSize: fontSize.sm, color: colors.textSecondary },
    standingsSortCell: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    // Narrow sort cells align with the mini-table's numeric columns instead of
    // rendering a second row of pill chips.
    standingsSortCellNarrow: {
        minHeight: 44,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    playoffCutRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xs,
    },
    playoffCutRule: { flex: 1, height: 1, backgroundColor: colors.border },
    playoffCutLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    standingsSortLiveStatus: {
        ...srOnly,
    },
    standingsScroll: { flex: 1 },
    standingsContent: { paddingBottom: spacing['3xl'] },
    standingsContentCompactLandscape: { paddingBottom: 96 },
    standingsLegend: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        fontSize: fontSize.xs,
        color: colors.textMuted,
        lineHeight: 16,
    },
})
