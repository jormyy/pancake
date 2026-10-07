import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { LeaguePickItem } from '@/lib/rookieDraft'
import { colors, fontSize, fontWeight, layout, radii, spacing, srOnly, table, textStyles } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { SectionHeader } from '@/components/SectionHeader'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { useWebViewport } from '@/hooks/use-web-viewport'
import { usePageMetrics } from '@/components/ui/Page'
import type { LeagueStatus } from '@/types/database'

type PickLedgerFilter = 'mine' | 'all' | 'traded'

const PICK_FILTER_OPTIONS: SegmentOption<PickLedgerFilter>[] = [
    { value: 'mine', label: 'Mine' },
    { value: 'all', label: 'All' },
    { value: 'traded', label: 'Traded' },
]
const PICK_FILTER_TAB_ID_BASE = 'draft-pick-filter'
const PICK_FILTER_PANEL_ID = 'draft-pick-results'

function effectivePickFilter(filter: PickLedgerFilter, hasMemberId: boolean): PickLedgerFilter {
    return filter === 'mine' && !hasMemberId ? 'all' : filter
}

function pickFilterOptions(hasMemberId: boolean) {
    return hasMemberId ? PICK_FILTER_OPTIONS : PICK_FILTER_OPTIONS.filter((option) => option.value !== 'mine')
}

function pickFilterGroupAccessibilityLabel(
    filter: PickLedgerFilter,
    totalCount: number,
    mineCount: number,
    tradedCount: number,
    hasMemberId: boolean,
    loading?: boolean,
) {
    const active =
        filter === 'mine' && hasMemberId
            ? loading ? 'my draft picks loading' : `my draft picks, ${countLabel(mineCount, 'pick')}`
            : filter === 'traded'
              ? loading ? 'traded draft picks loading' : `traded draft picks, ${countLabel(tradedCount, 'pick')}`
              : loading ? 'all draft picks loading' : `all draft picks, ${countLabel(totalCount, 'pick')}`
    return `Draft asset filters, showing ${active}`
}

type PicksBankItem =
    | { type: 'yearHeader'; year: number; id: string }
    | { type: 'pick'; pick: LeaguePickItem; id: string }

function PicksBankYearHeader({ year }: { year: number }) {
    return <SectionHeader label={String(year)} decorative />
}

function pickRowLabel(pick: LeaguePickItem, isMine: boolean) {
    const owner = isMine ? 'You' : pick.currentTeamName
    const tradeState = pick.originalOwnerMemberId !== pick.currentOwnerMemberId ? 'traded pick' : 'original pick'
    return `${pick.seasonYear} round ${pick.round}, from ${pick.originalTeamName}, owner ${owner}, ${tradeState}`
}

function PicksBankRow({
    pick,
    isMine,
    highlightMine,
    compact,
    landscapeDense,
    padX,
}: {
    pick: LeaguePickItem
    isMine: boolean
    highlightMine: boolean
    compact: boolean
    landscapeDense: boolean
    padX: number
}) {
    const mine = isMine && highlightMine
    const isTraded = pick.originalOwnerMemberId !== pick.currentOwnerMemberId
    const label = pickRowLabel(pick, isMine)
    return (
        <View
            style={[
                styles.picksBankRow,
                { paddingHorizontal: padX },
                landscapeDense && styles.picksBankRowLandscapeDense,
                mine && tableStyles.rowMe,
            ]}
            role="listitem"
            aria-label={label}
            accessibilityRole="text"
            accessibilityLabel={label}
        >
            <Text
                style={[styles.picksBankRound, compact && styles.picksBankRoundCompact, mine && tableStyles.textMe]}
                numberOfLines={1}
            >
                {compact ? `${pick.seasonYear} R${pick.round}` : `R${pick.round}`}
            </Text>
            <View style={styles.picksBankFromWrap}>
                <Text style={[styles.picksBankFrom, mine && tableStyles.textMe]} numberOfLines={1}>
                    {pick.originalTeamName}
                </Text>
                {isTraded ? (
                    <View style={styles.picksBankTradePill}>
                        <Text style={styles.picksBankTradeText}>Traded</Text>
                    </View>
                ) : null}
            </View>
            <Text style={[styles.picksBankOwner, mine && tableStyles.textMe]} numberOfLines={1}>
                {isMine ? 'You' : pick.currentTeamName}
            </Text>
        </View>
    )
}

function PicksBankColumns({ padX, compact }: { padX: number; compact: boolean }) {
    return (
        <View style={[styles.picksBankHeader, { paddingHorizontal: padX }]}>
            <Text style={[textStyles.tableHeader, styles.picksBankHeaderRound, compact && styles.picksBankRoundCompact]} numberOfLines={1} accessibilityLabel="Draft round">{compact ? 'Pick' : 'Round'}</Text>
            <Text style={[textStyles.tableHeader, styles.picksBankHeaderFrom]} accessibilityLabel="Original team">From</Text>
            <Text style={[textStyles.tableHeader, styles.picksBankHeaderOwner]} accessibilityLabel="Current owner">Owner</Text>
        </View>
    )
}

// Deterministic pick order: year asc → round asc → owner name → original team
// name → id. Without the name/id tiebreakers, picks sharing a year+round (a
// team holding multiple same-round picks via trades) come back in arbitrary,
// run-to-run order from Postgres and the list visibly shuffles.
function comparePicks(a: LeaguePickItem, b: LeaguePickItem): number {
    return (
        a.seasonYear - b.seasonYear ||
        a.round - b.round ||
        a.currentTeamName.localeCompare(b.currentTeamName) ||
        a.originalTeamName.localeCompare(b.originalTeamName) ||
        a.id.localeCompare(b.id)
    )
}

function PicksLedgerHeader({
    filter,
    onFilterChange,
    flatHasRows,
    compactColumns,
    totalCount,
    mineCount,
    tradedCount,
    hasMemberId,
    padX,
    loading,
}: {
    filter: PickLedgerFilter
    onFilterChange: (filter: PickLedgerFilter) => void
    flatHasRows: boolean
    compactColumns: boolean
    totalCount: number
    mineCount: number
    tradedCount: number
    hasMemberId: boolean
    padX: number
    loading?: boolean
}) {
    const pickCountState = (count: number) => loading ? 'loading' : countLabel(count, 'pick')
    const totalStatLabel = loading ? 'Assets loading' : `${totalCount} total`
    const mineStatLabel = loading || !hasMemberId ? 'Mine loading' : `${mineCount} mine`
    const tradedStatLabel = loading ? 'Traded loading' : `${tradedCount} traded`
    const headerAccessibilityLabel = `Draft assets. ${totalStatLabel}. ${mineStatLabel}. ${tradedStatLabel}.`
    const filterAccessibilityLabel = pickFilterGroupAccessibilityLabel(filter, totalCount, mineCount, tradedCount, hasMemberId, loading)
    const options = pickFilterOptions(hasMemberId).map((option) => {
        const badge =
            option.value === 'mine'
                ? mineCount
                : option.value === 'traded'
                  ? tradedCount
                  : totalCount
        const accessibilityLabel =
            option.value === 'mine'
                ? `Show my draft picks, ${pickCountState(mineCount)}`
                : option.value === 'traded'
                  ? `Show traded draft picks, ${pickCountState(tradedCount)}`
                  : `Show all draft picks, ${pickCountState(totalCount)}`
        return { ...option, badge, accessibilityLabel }
    })

    // The filter counts already say how many picks there are, so the header is
    // just the filters; the summary stays available to screen readers.
    return (
        <>
            <View
                style={[styles.picksLedgerIntro, { paddingHorizontal: padX }]}
                role="group"
                aria-label={headerAccessibilityLabel}
                aria-live="polite"
                aria-busy={loading ? true : undefined}
                accessibilityLabel={headerAccessibilityLabel}
                accessibilityLiveRegion="polite"
                accessibilityState={{ busy: loading }}
            >
                <Text style={srOnly} role="heading" aria-level={2} accessibilityRole="header">Draft assets</Text>
                <SegmentedControl
                    options={options}
                    value={filter}
                    onChange={onFilterChange}
                    accessibilityLabel={filterAccessibilityLabel}
                    idBase={PICK_FILTER_TAB_ID_BASE}
                    controlledPanelId={PICK_FILTER_PANEL_ID}
                    scrollable
                />
            </View>
            {flatHasRows ? <PicksBankColumns padX={padX} compact={compactColumns} /> : null}
        </>
    )
}

function pickEmptyCopy(filter: PickLedgerFilter, hasAnyPicks: boolean) {
    if (!hasAnyPicks) {
        return {
            message: 'No future draft picks to display.',
            description: 'Rookie pick assets appear here once the league creates them.',
        }
    }
    if (filter === 'mine') {
        return {
            message: 'No picks assigned to you yet.',
            description: 'Switch to All to inspect the full league draft asset ledger.',
        }
    }
    if (filter === 'traded') {
        return {
            message: 'No traded picks yet.',
            description: 'Completed pick trades will appear here with the original team and current owner.',
        }
    }
    return {
        message: 'No future draft picks to display.',
        description: 'Rookie pick assets appear here once the league creates them.',
    }
}

function pickListName(filter: PickLedgerFilter) {
    if (filter === 'mine') return 'My draft picks'
    if (filter === 'traded') return 'Traded draft picks'
    return 'All draft picks'
}

function pickListAccessibilityLabel(filter: PickLedgerFilter, count: number) {
    return `${pickListName(filter)}, ${countLabel(count, 'pick')}`
}

function pickListLoadingAccessibilityLabel(filter: PickLedgerFilter) {
    return `${pickListName(filter)} loading`
}

function pickListRefreshingAccessibilityLabel(filter: PickLedgerFilter, count: number) {
    return `${pickListName(filter)} loading, ${countLabel(count, 'pick')} currently shown`
}

function pickPanelAccessibilityLabel({
    listAccessibilityLabel,
    empty,
    loading,
    hasVisiblePicks,
}: {
    listAccessibilityLabel: string
    empty: { message: string; description: string }
    loading?: boolean
    hasVisiblePicks: boolean
}) {
    if (hasVisiblePicks && loading) return `${listAccessibilityLabel}. ${empty.description}`
    if (hasVisiblePicks) return `${listAccessibilityLabel} results`
    if (loading) return `${listAccessibilityLabel}. ${empty.description}`
    return `${listAccessibilityLabel} results. ${empty.message} ${empty.description}`
}

function pickFilterTabId(filter: PickLedgerFilter) {
    return `${PICK_FILTER_TAB_ID_BASE}-${filter}`
}

export function PicksBankList({
    picks,
    myMemberId,
    loading,
    leagueStatus,
}: {
    picks: LeaguePickItem[]
    myMemberId?: string
    loading?: boolean
    leagueStatus?: LeagueStatus
}) {
    const [filter, setFilter] = useState<PickLedgerFilter>('mine')
    const { viewportWidth, viewportHeight, compactLandscape } = useWebViewport()
    const { padX } = usePageMetrics()
    const narrowRows = viewportWidth < 440
    const compactHeader = viewportHeight < 500 || narrowRows
    const compactRows = compactHeader || narrowRows
    const landscapeDenseRows = compactLandscape && !narrowRows
    const hasMemberId = Boolean(myMemberId)
    const activeFilter = effectivePickFilter(filter, hasMemberId)

    useEffect(() => {
        if (!hasMemberId && filter === 'mine') setFilter('all')
    }, [filter, hasMemberId])

    const mineCount = useMemo(
        () => myMemberId ? picks.filter((pick) => pick.currentOwnerMemberId === myMemberId).length : 0,
        [myMemberId, picks],
    )
    const tradedCount = useMemo(
        () => picks.filter((pick) => pick.originalOwnerMemberId !== pick.currentOwnerMemberId).length,
        [picks],
    )
    const visiblePicks = useMemo(() => {
        if (activeFilter === 'mine' && myMemberId) {
            return picks.filter((pick) => pick.currentOwnerMemberId === myMemberId)
        }
        if (activeFilter === 'traded') {
            return picks.filter((pick) => pick.originalOwnerMemberId !== pick.currentOwnerMemberId)
        }
        return picks
    }, [activeFilter, myMemberId, picks])

    const flatData = useMemo<PicksBankItem[]>(() => {
        const byYear = new Map<number, LeaguePickItem[]>()
        for (const p of [...visiblePicks].sort(comparePicks)) {
            if (!byYear.has(p.seasonYear)) byYear.set(p.seasonYear, [])
            byYear.get(p.seasonYear)!.push(p)
        }
        const result: PicksBankItem[] = []
        for (const [year, yearPicks] of Array.from(byYear.entries()).sort((a, b) => a[0] - b[0])) {
            if (!compactRows) result.push({ type: 'yearHeader', year, id: `year-${year}` })
            for (const p of yearPicks) {
                result.push({ type: 'pick', pick: p, id: p.id })
            }
        }
        return result
    }, [compactRows, visiblePicks])
    const listKey = useMemo(
        () => `${activeFilter}:${compactRows}:${flatData.map((item) => item.id).join('|')}`,
        [activeFilter, compactRows, flatData],
    )
    const hasVisiblePicks = visiblePicks.length > 0
    const listAccessibilityLabel = loading
        ? hasVisiblePicks
            ? pickListRefreshingAccessibilityLabel(activeFilter, visiblePicks.length)
            : pickListLoadingAccessibilityLabel(activeFilter)
        : pickListAccessibilityLabel(activeFilter, visiblePicks.length)
    const empty = loading
        ? {
              message: 'Loading draft assets...',
              description: 'Fetching future picks and traded ownership.',
          }
        : pickEmptyCopy(activeFilter, picks.length > 0)
    const panelAccessibilityLabel = pickPanelAccessibilityLabel({
        listAccessibilityLabel,
        empty,
        loading,
        hasVisiblePicks,
    })
    const deferHeaderUntilAfterRows = compactLandscape && flatData.length > 0
    const ledgerHeader = (
        <PicksLedgerHeader
            filter={activeFilter}
            onFilterChange={setFilter}
            flatHasRows={flatData.length > 0}
            compactColumns={compactRows}
            totalCount={picks.length}
            mineCount={mineCount}
            tradedCount={tradedCount}
            hasMemberId={hasMemberId}
            padX={padX}
            loading={loading}
        />
    )

    return (
        <ScrollView
            key={listKey}
            style={styles.picksBankScroll}
            contentContainerStyle={[styles.picksBankContent, styles.column]}
            removeClippedSubviews={false}
        >
            {deferHeaderUntilAfterRows ? null : ledgerHeader}
            <View
                nativeID={PICK_FILTER_PANEL_ID}
                role="tabpanel"
                aria-live="polite"
                aria-busy={loading ? true : undefined}
                aria-label={panelAccessibilityLabel}
                aria-labelledby={pickFilterTabId(activeFilter)}
                accessibilityLabel={panelAccessibilityLabel}
                accessibilityState={{ busy: loading }}
                accessibilityLiveRegion="polite"
            >
                {flatData.length ? (
                    <View
                        role="list"
                        aria-label={listAccessibilityLabel}
                        accessibilityRole="list"
                        accessibilityLabel={listAccessibilityLabel}
                    >
                        {flatData.map((item, index) => (
                            <Fragment key={item.id}>
                                {index > 0 ? <ItemSeparator /> : null}
                                {item.type === 'yearHeader' ? (
                                    <PicksBankYearHeader year={item.year} />
                                ) : (
                                    <PicksBankRow
                                        pick={item.pick}
                                        isMine={item.pick.currentOwnerMemberId === myMemberId}
                                        // Every row in "Mine" is yours; tint only where it tells rows apart.
                                        highlightMine={activeFilter !== 'mine'}
                                        compact={compactRows}
                                        landscapeDense={landscapeDenseRows}
                                        padX={padX}
                                    />
                                )}
                            </Fragment>
                        ))}
                    </View>
                ) : (
                    <View
                        role="status"
                        aria-live="polite"
                        aria-busy={loading ? true : undefined}
                        aria-label={panelAccessibilityLabel}
                        accessibilityLabel={panelAccessibilityLabel}
                        accessibilityState={{ busy: loading }}
                        accessibilityLiveRegion="polite"
                    >
                        <EmptyState message={empty.message} description={empty.description} fullScreen={false} />
                    </View>
                )}
            </View>
            {deferHeaderUntilAfterRows ? ledgerHeader : null}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    column: { width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular },
    picksBankHeader: {
        minHeight: table.headerHeight,
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    picksBankHeaderRound: { width: 56 },
    picksBankHeaderFrom: { flex: 1, marginLeft: spacing.lg },
    picksBankHeaderOwner: { width: 96, textAlign: 'right' },
    picksBankRow: {
        minHeight: table.rowHeightCompact,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
    },
    picksBankRowLandscapeDense: {
        minHeight: 28,
        paddingVertical: spacing.xs,
    },
    picksBankRound: { width: 56, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    picksBankRoundCompact: { width: 68 },
    picksBankFromWrap: {
        flex: 1,
        minWidth: 0,
        marginLeft: spacing.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    picksBankFrom: { flex: 1, minWidth: 0, fontSize: fontSize.sm, color: colors.textSecondary },
    picksBankTradePill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.warningLight,
    },
    picksBankTradeText: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: colors.warningDark,
    },
    picksBankOwner: { width: 96, textAlign: 'right', fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    picksLedgerIntro: {
        paddingTop: spacing.lg,
        paddingBottom: spacing.md,
    },
    picksBankScroll: { flex: 1 },
    picksBankContent: { paddingBottom: spacing['3xl'] },
})
