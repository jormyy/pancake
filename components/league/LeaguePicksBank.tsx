import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { LeaguePickItem } from '@/lib/rookieDraft'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { SectionHeader } from '@/components/SectionHeader'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { tableStyles } from '@/components/league/leagueTableStyles'
import { useWebViewport } from '@/hooks/use-web-viewport'
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
    compact,
    narrow,
    landscapeDense,
}: {
    pick: LeaguePickItem
    isMine: boolean
    compact: boolean
    narrow: boolean
    landscapeDense: boolean
}) {
    const isTraded = pick.originalOwnerMemberId !== pick.currentOwnerMemberId
    const label = pickRowLabel(pick, isMine)
    return (
        <View
            style={[
                styles.picksBankRow,
                landscapeDense && styles.picksBankRowLandscapeDense,
                narrow && styles.picksBankRowNarrow,
                isMine && tableStyles.rowMe,
            ]}
            role="listitem"
            aria-label={label}
            accessibilityRole="text"
            accessibilityLabel={label}
        >
            <Text
                style={[styles.picksBankRound, compact && styles.picksBankRoundCompact, narrow && styles.picksBankRoundNarrow, isMine && tableStyles.textMe]}
                numberOfLines={1}
            >
                {compact ? `${pick.seasonYear} R${pick.round}` : `R${pick.round}`}
            </Text>
            <View style={[styles.picksBankFromWrap, narrow && styles.picksBankFromWrapNarrow]}>
                <Text style={[styles.picksBankFrom, isMine && tableStyles.textMe]} numberOfLines={1}>
                    {compact ? <Text style={styles.picksBankInlineLabel}>From </Text> : null}
                    {pick.originalTeamName}
                </Text>
                {isTraded ? (
                    <View style={styles.picksBankTradePill}>
                        <Text style={styles.picksBankTradeText}>Traded</Text>
                    </View>
                ) : null}
            </View>
            <Text style={[styles.picksBankOwner, narrow && styles.picksBankOwnerNarrow, isMine && tableStyles.textMe]} numberOfLines={1}>
                {compact ? <Text style={styles.picksBankInlineLabel}>Owner </Text> : null}
                {isMine ? 'You' : pick.currentTeamName}
            </Text>
        </View>
    )
}

function PicksBankColumns({ compact }: { compact: boolean }) {
    return (
        <View style={styles.picksBankHeader}>
            <Text style={[tableStyles.headerText, styles.picksBankHeaderRound, compact && styles.picksBankRoundCompact]} numberOfLines={1} accessibilityLabel="Draft round">ROUND</Text>
            <Text style={[tableStyles.headerText, styles.picksBankHeaderFrom]} accessibilityLabel="Original team">FROM</Text>
            <Text style={[tableStyles.headerText, styles.picksBankHeaderOwner]} accessibilityLabel="Current owner">OWNER</Text>
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

function pickLedgerIntroCopy(status?: LeagueStatus) {
    switch (status) {
        case 'active':
        case 'playoffs':
            return {
                copy: 'Future rookie picks stay visible during the live season for trades and long-term planning. Traded picks show their original team and current owner.',
                compactCopy: 'Live-season trade assets',
            }
        case 'offseason':
            return {
                copy: 'Pick ownership is the source of truth before the rookie draft clock starts. Traded picks show their original team and current owner.',
                compactCopy: 'Rookie draft ownership',
            }
        case 'drafting':
            return {
                copy: 'Startup draft is live while future rookie pick ownership remains available for roster planning and trade context.',
                compactCopy: 'Drafting with pick context',
            }
        case 'archived':
            return {
                copy: 'Future pick ownership is preserved with league history, including traded picks and original teams.',
                compactCopy: 'Preserved pick history',
            }
        default:
            return {
                copy: 'Future rookie picks stay visible before the draft clock starts. Traded picks show their original team and current owner.',
                compactCopy: 'Future pick ownership',
            }
    }
}

function pickLedgerCompactCopy(intro: { compactCopy: string }, loading: boolean | undefined, totalCount: number) {
    if (!loading) return intro.compactCopy
    return totalCount > 0 ? 'Refreshing draft assets' : 'Draft assets loading'
}

function PicksLedgerHeader({
    filter,
    onFilterChange,
    flatHasRows,
    showColumns,
    totalCount,
    mineCount,
    tradedCount,
    hasMemberId,
    compact,
    loading,
    leagueStatus,
}: {
    filter: PickLedgerFilter
    onFilterChange: (filter: PickLedgerFilter) => void
    flatHasRows: boolean
    showColumns: boolean
    totalCount: number
    mineCount: number
    tradedCount: number
    hasMemberId: boolean
    compact: boolean
    loading?: boolean
    leagueStatus?: LeagueStatus
}) {
    const intro = pickLedgerIntroCopy(leagueStatus)
    const pickCountState = (count: number) => loading ? 'loading' : countLabel(count, 'pick')
    const totalStatLabel = loading ? 'Assets loading' : `${totalCount} total`
    const mineStatLabel = loading || !hasMemberId ? 'Mine loading' : `${mineCount} mine`
    const tradedStatLabel = loading ? 'Traded loading' : `${tradedCount} traded`
    const compactCopy = pickLedgerCompactCopy(intro, loading, totalCount)
    const headerAccessibilityLabel = `Draft assets. ${compact ? compactCopy : intro.copy} ${totalStatLabel}. ${mineStatLabel}. ${tradedStatLabel}.`
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

    return (
        <>
            <View
                style={[styles.picksLedgerIntro, compact && styles.picksLedgerIntroCompact]}
                role="group"
                aria-label={headerAccessibilityLabel}
                aria-live="polite"
                aria-busy={loading ? true : undefined}
                accessibilityLabel={headerAccessibilityLabel}
                accessibilityLiveRegion="polite"
                accessibilityState={{ busy: loading }}
            >
                {compact ? (
                    <View style={styles.picksLedgerCompactSummary}>
                        <Text style={styles.picksLedgerCompactTitle} numberOfLines={1} role="heading" aria-level={2}>Draft assets</Text>
                        <Text style={styles.picksLedgerCompactCopy} numberOfLines={1}>{compactCopy}</Text>
                    </View>
                ) : (
                    <View>
                        <Text style={styles.picksLedgerTitle} role="heading" aria-level={2}>Draft assets</Text>
                        <Text style={styles.picksLedgerCopy}>
                            {intro.copy}
                        </Text>
                    </View>
                )}
                {compact ? null : (
                    <View style={styles.picksLedgerStats}>
                        <View style={styles.picksLedgerStat}>
                            <Text style={styles.picksLedgerStatText}>{totalStatLabel}</Text>
                        </View>
                        <View style={styles.picksLedgerStat}>
                            <Text style={styles.picksLedgerStatText}>{mineStatLabel}</Text>
                        </View>
                        <View style={styles.picksLedgerStat}>
                            <Text style={styles.picksLedgerStatText}>{tradedStatLabel}</Text>
                        </View>
                    </View>
                )}
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
            {flatHasRows && showColumns ? <PicksBankColumns compact={compact} /> : null}
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
            showColumns={flatData.length > 0 && !compactRows}
            totalCount={picks.length}
            mineCount={mineCount}
            tradedCount={tradedCount}
            hasMemberId={hasMemberId}
            compact={compactHeader}
            loading={loading}
            leagueStatus={leagueStatus}
        />
    )

    return (
        <ScrollView
            key={listKey}
            style={styles.picksBankScroll}
            contentContainerStyle={styles.picksBankContent}
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
                                        compact={compactRows}
                                        narrow={narrowRows}
                                        landscapeDense={landscapeDenseRows}
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
    picksBankHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    picksBankHeaderRound: { width: 56 },
    picksBankHeaderFrom: { flex: 1, marginLeft: spacing.lg },
    picksBankHeaderOwner: { width: 110, textAlign: 'right' },
    picksBankRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    picksBankRowLandscapeDense: {
        minHeight: 28,
        paddingVertical: spacing.xs,
    },
    picksBankRowNarrow: {
        flexDirection: 'column',
        alignItems: 'stretch',
        paddingVertical: spacing.md,
        gap: spacing.xxs,
    },
    picksBankRound: { width: 56, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    picksBankRoundCompact: { width: 68 },
    picksBankRoundNarrow: { width: 'auto' },
    picksBankFromWrap: {
        flex: 1,
        minWidth: 0,
        marginLeft: spacing.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    picksBankFromWrapNarrow: { marginLeft: 0 },
    picksBankFrom: { flex: 1, minWidth: 0, fontSize: fontSize.sm, color: colors.textSecondary },
    picksBankInlineLabel: {
        color: colors.textPlaceholder,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        textTransform: 'uppercase',
    },
    picksBankTradePill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.warningLight,
    },
    picksBankTradeText: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.warningDark,
    },
    picksBankOwner: { width: 110, textAlign: 'right', fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    picksBankOwnerNarrow: { width: 'auto', textAlign: 'left' },
    picksLedgerIntro: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
        gap: spacing.md,
        backgroundColor: colors.bgCard,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    picksLedgerIntroCompact: {
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
        gap: spacing.sm,
    },
    picksLedgerCompactSummary: {
        minHeight: 20,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    picksLedgerCompactTitle: {
        color: colors.textPrimary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    picksLedgerCompactCopy: {
        flex: 1,
        minWidth: 0,
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
    },
    picksLedgerTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    picksLedgerCopy: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textSecondary,
    },
    picksLedgerStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    picksLedgerStat: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    picksLedgerStatText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    picksBankScroll: { flex: 1 },
    picksBankContent: { paddingBottom: spacing['3xl'] },
})
