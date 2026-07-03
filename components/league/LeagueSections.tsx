import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions, Platform } from 'react-native'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import { compareStandingsRows, type StandingRow } from '@/lib/scoring'
import { WaiverPriorityRow } from '@/lib/waivers'
import { TransactionRow, TRANSACTION_LABELS } from '@/lib/transactions'
import { LeaguePickItem } from '@/lib/rookieDraft'
import { getPositionColor } from '@/constants/positions'
import { colors, fontSize, fontWeight, radii, spacing, TX_COLORS } from '@/constants/tokens'
import { playerHeadshotUrl, timeAgo } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { SectionHeader } from '@/components/SectionHeader'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import type { LeagueStatus } from '@/types/database'

type StandingsSortKey = 'wins' | 'pf' | 'maxPf' | 'pa'
type PickLedgerFilter = 'mine' | 'all' | 'traded'

const PICK_FILTER_OPTIONS: SegmentOption<PickLedgerFilter>[] = [
    { value: 'mine', label: 'Mine' },
    { value: 'all', label: 'All' },
    { value: 'traded', label: 'Traded' },
]
const PICK_FILTER_TAB_ID_BASE = 'draft-pick-filter'
const PICK_FILTER_PANEL_ID = 'draft-pick-results'
const STANDINGS_LIST_ID = 'league-standings-results'

const STANDINGS_SORT_LABELS: Record<StandingsSortKey, string> = {
    wins: 'wins',
    pf: 'points for',
    maxPf: 'maximum possible points for',
    pa: 'points against',
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`
}

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
        `record ${countLabel(item.wins, 'win')}, ${countLabel(item.losses, 'loss', 'losses')}, ${countLabel(item.ties, 'tie')}`,
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

// Styles must be declared before any const JSX that references them
const styles = StyleSheet.create({
    standingsRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    standingsRowNarrow: {
        flexDirection: 'column',
        alignItems: 'stretch',
        paddingVertical: spacing.xs,
        gap: spacing.xxs,
    },
    standingsRowMe: { backgroundColor: colors.primaryLight },
    standingsHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    standingsHeaderNarrow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 0,
        gap: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    standingsHeaderText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    standingsHeaderActive: { color: colors.primaryDark },
    standingsRank: { width: 24, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    standingsRankNarrow: { width: 28, textAlign: 'center' },
    standingsTeam: { flex: 1, minWidth: 72, paddingRight: spacing.md, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    standingsTeamWrap: { flex: 1, minWidth: 72, paddingRight: spacing.md, alignItems: 'flex-start', justifyContent: 'center', gap: spacing.xxs },
    standingsTeamWrapNarrow: { minWidth: 0, paddingRight: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    standingsTeamName: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    standingsIdentityNarrow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
    standingsStatsNarrow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingLeft: 40 },
    standingsStatNarrow: {
        minHeight: 26,
        paddingHorizontal: spacing.md,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
    },
    standingsStatTextNarrow: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textSecondary },
    standingsStatLabelNarrow: { color: colors.textPlaceholder, textTransform: 'uppercase' },
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
    standingsSortCellNarrow: {
        minHeight: 44,
        minWidth: 64,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
        alignItems: 'center',
        justifyContent: 'center',
    },
    standingsSortCellNarrowActive: {
        borderColor: colors.primary,
        backgroundColor: colors.primaryLight,
    },
    standingsSortLiveStatus: {
        position: 'absolute',
        width: 1,
        height: 1,
        margin: -1,
        overflow: 'hidden',
        opacity: 0,
    },
    standingsScroll: { flex: 1 },
    standingsContent: { paddingBottom: spacing['3xl'] },
    standingsContentCompactLandscape: { paddingBottom: 96 },
    standingsMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    standingsIntro: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xl,
        paddingBottom: spacing.lg,
        gap: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    standingsIntroTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    standingsIntroCopy: {
        fontSize: fontSize.sm,
        color: colors.textSecondary,
        lineHeight: 18,
    },
    standingsIntroStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    standingsIntroStat: {
        minHeight: 32,
        paddingHorizontal: spacing.lg,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
    },
    standingsIntroStatText: {
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
    standingsLegend: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        fontSize: fontSize.xs,
        color: colors.textMuted,
        lineHeight: 16,
    },
    standingsIntroAction: {
        minHeight: 44,
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    standingsIntroActionText: {
        color: colors.textWhite,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    standingsCompactIntro: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        paddingBottom: spacing.xs,
        gap: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    standingsCompactIntroText: {
        minWidth: 0,
        gap: spacing.xxs,
    },
    standingsCompactIntroTitle: {
        color: colors.textPrimary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    standingsCompactIntroCopy: {
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
    },
    standingsCompactStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    standingsCompactStat: {
        minHeight: 28,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
    },
    standingsCompactStatText: {
        color: colors.textSecondary,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
    standingsCompactAction: {
        minHeight: 44,
        marginHorizontal: spacing.md,
        marginTop: spacing.sm,
        marginBottom: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    standingsCompactActionEmbedded: {
        marginHorizontal: 0,
        marginTop: 0,
        marginBottom: 0,
    },

    waiverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    waiverHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    waiverRank: { width: 32, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    waiverTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    waiverName: { width: 110, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },

    txRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    txRowCompact: {
        minHeight: 52,
        paddingVertical: spacing.xs,
        gap: spacing.md,
    },
    txRowMe: { backgroundColor: colors.primaryLight },
    txInfo: { flex: 1, gap: spacing.xxs },
    txNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    txPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    txPlayerCompact: { fontSize: fontSize.sm },
    txTeam: { fontSize: 12, color: colors.textMuted },
    txRight: { alignItems: 'flex-end', gap: spacing.xs },
    txTime: { fontSize: fontSize.xs, color: colors.textPlaceholder },
    meTag: { color: colors.textPlaceholder, fontWeight: fontWeight.regular, fontSize: fontSize.sm },
    activityFooterAction: {
        minHeight: 44,
        padding: spacing['2xl'],
        alignItems: 'center',
        justifyContent: 'center',
    },

    picksBankHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    picksBankHeaderRound: { width: 36 },
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
    picksBankRound: { width: 36, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
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


function StandingsStat({
    label,
    value,
    isMe,
}: {
    label: string
    value: string | number
    isMe: boolean
}) {
    return (
        <View style={styles.standingsStatNarrow}>
            <Text style={[styles.standingsStatTextNarrow, isMe && styles.standingsMe]} numberOfLines={1}>
                <Text style={styles.standingsStatLabelNarrow}>{label} </Text>
                {value}
            </Text>
        </View>
    )
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
            style={[styles.standingsRow, narrow && styles.standingsRowNarrow, isMe && styles.standingsRowMe]}
            onPress={onPress}
            role="button"
            aria-label={label}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            {narrow ? (
                <>
                    <View style={styles.standingsIdentityNarrow}>
                        <Text style={[styles.standingsRank, styles.standingsRankNarrow, isMe && styles.standingsMe]}>{index + 1}</Text>
                        <View style={[styles.standingsTeamWrap, styles.standingsTeamWrapNarrow]}>
                            <Text style={[styles.standingsTeamName, isMe && styles.standingsMe]} numberOfLines={1}>
                                {item.teamName}
                            </Text>
                            {isMe ? (
                                <View style={styles.standingsYouPill} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                    <Text style={styles.standingsYouText}>You</Text>
                                </View>
                            ) : null}
                        </View>
                    </View>
                    <View style={styles.standingsStatsNarrow}>
                        <StandingsStat label="W" value={item.wins} isMe={isMe} />
                        <StandingsStat label="L" value={item.losses} isMe={isMe} />
                        <StandingsStat label="T" value={item.ties} isMe={isMe} />
                        <StandingsStat label="PF" value={item.pointsFor.toFixed(1)} isMe={isMe} />
                        {showMaxPf ? <StandingsStat label="MAX PF" value={item.maxPointsFor.toFixed(1)} isMe={isMe} /> : null}
                        {showPa ? <StandingsStat label="PA" value={item.pointsAgainst.toFixed(1)} isMe={isMe} /> : null}
                    </View>
                </>
            ) : (
                <>
                    <Text style={[styles.standingsRank, isMe && styles.standingsMe]}>{index + 1}</Text>
                    <View style={styles.standingsTeamWrap}>
                        <Text style={[styles.standingsTeamName, isMe && styles.standingsMe]} numberOfLines={1}>
                            {item.teamName}
                        </Text>
                        {isMe ? (
                            <View style={styles.standingsYouPill} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                <Text style={styles.standingsYouText}>You</Text>
                            </View>
                        ) : null}
                    </View>
                    <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.wins}</Text>
                    <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.losses}</Text>
                    <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.ties}</Text>
                    <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsFor.toFixed(1)}</Text>
                    {showMaxPf ? <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.maxPointsFor.toFixed(1)}</Text> : null}
                    {showPa ? <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsAgainst.toFixed(1)}</Text> : null}
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
    const narrowSortButton = (key: StandingsSortKey, label: string) => (
        <Pressable
            key={key}
            style={[styles.standingsSortCellNarrow, sortBy === key && styles.standingsSortCellNarrowActive]}
            onPress={() => onSort(key)}
            role="button"
            aria-label={standingsSortAccessibilityLabel(key, sortBy, sortDir)}
            aria-controls={STANDINGS_LIST_ID}
            aria-pressed={sortBy === key}
            accessibilityRole="button"
            accessibilityLabel={standingsSortAccessibilityLabel(key, sortBy, sortDir)}
            accessibilityState={{ selected: sortBy === key }}
        >
            <Text style={[styles.standingsHeaderText, sortBy === key && styles.standingsHeaderActive]}>{label}{arrow(key)}</Text>
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
                    style={styles.standingsHeaderNarrow}
                    role="toolbar"
                    aria-label={sortControlsLabel}
                    accessibilityLabel={sortControlsLabel}
                >
                    {narrowSortButton('wins', 'Wins')}
                    {narrowSortButton('pf', 'PF')}
                    {showMaxPf ? narrowSortButton('maxPf', 'Max PF') : null}
                    {showPa ? narrowSortButton('pa', 'PA') : null}
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
                <Text style={[styles.standingsRank, styles.standingsHeaderText]} accessibilityLabel="Rank">#</Text>
                <Text style={[styles.standingsTeam, styles.standingsHeaderText]} accessibilityLabel="Team name">Team</Text>
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
                    <Text style={[styles.standingsHeaderText, sortBy === 'wins' && styles.standingsHeaderActive]}>W{arrow('wins')}</Text>
                </Pressable>
                <Text style={[styles.standingsCell, styles.standingsHeaderText]} accessibilityLabel="Losses">L</Text>
                <Text style={[styles.standingsCell, styles.standingsHeaderText]} accessibilityLabel="Ties">T</Text>
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
                    <Text style={[styles.standingsHeaderText, sortBy === 'pf' && styles.standingsHeaderActive]}>PF{arrow('pf')}</Text>
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
                        <Text style={[styles.standingsHeaderText, sortBy === 'maxPf' && styles.standingsHeaderActive]}>MAX PF{arrow('maxPf')}</Text>
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
                        <Text style={[styles.standingsHeaderText, sortBy === 'pa' && styles.standingsHeaderActive]}>PA{arrow('pa')}</Text>
                    </Pressable>
                ) : null}
            </View>
        </Fragment>
    )
}

function standingsIntroCopy(status?: LeagueStatus) {
    switch (status) {
        case 'setup':
            return {
                title: 'Everyone starts 0-0',
                copy: 'The full league table is visible before the draft so every manager can see the field from day one.',
            }
        case 'drafting':
            return {
                title: 'Standings stay open during the draft',
                copy: 'Rosters are still forming, but every team remains listed here with records ready for scoring.',
            }
        case 'offseason':
            return {
                title: 'Offseason table is ready',
                copy: 'Review last cycle, inspect teams, and keep the next season visible before games return.',
            }
        case 'playoffs':
            return {
                title: 'Playoff standings',
                copy: 'Regular-season records stay intact while bracket play decides the title.',
            }
        case 'archived':
            return {
                title: 'Final standings',
                copy: 'This table is preserved for league history.',
            }
        default:
            return {
                title: 'Live standings',
                copy: 'Records and point totals update as regular-season games finalize.',
            }
    }
}

function standingsPointMetricLabels(showPa: boolean, showMaxPf: boolean) {
    const labels = ['PF']
    if (showMaxPf) labels.push('MAX PF')
    if (showPa) labels.push('PA')
    return labels
}

function standingsTeamCountLabel(teamCount: number, loading?: boolean) {
    return loading ? 'Teams loading' : `${teamCount} teams`
}

function standingsPointStatLabel(status: LeagueStatus | undefined, showPa: boolean, showMaxPf: boolean, loading?: boolean) {
    const metricLabel = standingsPointMetricLabels(showPa, showMaxPf).join(' / ')
    if (loading) return `${metricLabel} loading`
    switch (status) {
        case 'active':
            return `${metricLabel} live`
        case 'playoffs':
            return `${metricLabel} locked`
        case 'archived':
            return `${metricLabel} final`
        case 'offseason':
            return `${metricLabel} preserved`
        default:
            return `${metricLabel} ready`
    }
}

function standingsIntroStats(status: LeagueStatus | undefined, showPa: boolean, showMaxPf: boolean, loading?: boolean): [string, string] {
    if (loading) return ['Records loading', standingsPointStatLabel(status, showPa, showMaxPf, true)]
    switch (status) {
        case 'active':
            return ['Records updating', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'playoffs':
            return ['Records locked', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'archived':
            return ['Final records', standingsPointStatLabel(status, showPa, showMaxPf)]
        case 'offseason':
            return ['Records preserved', standingsPointStatLabel(status, showPa, showMaxPf)]
        default:
            return ['Records initialized', standingsPointStatLabel(status, showPa, showMaxPf)]
    }
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

function StandingsIntro({
    teamCount,
    status,
    showPa,
    showMaxPf,
    onOpenBracket,
    loading,
}: {
    teamCount: number
    status?: LeagueStatus
    showPa: boolean
    showMaxPf: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    const intro = standingsIntroCopy(status)
    const [recordStat, pointsStat] = standingsIntroStats(status, showPa, showMaxPf, loading)
    const teamStat = standingsTeamCountLabel(teamCount, loading)
    const showBracketAction = status === 'playoffs' && onOpenBracket
    const accessibilityLabel = `${intro.title}. ${intro.copy} ${teamStat}. ${recordStat}. ${pointsStat}.`

    return (
        <View
            style={styles.standingsIntro}
            role="group"
            aria-label={accessibilityLabel}
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <View>
                <Text style={styles.standingsIntroTitle}>{intro.title}</Text>
                <Text style={styles.standingsIntroCopy}>{intro.copy}</Text>
            </View>
            <View style={styles.standingsIntroStats}>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{teamStat}</Text>
                </View>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{recordStat}</Text>
                </View>
                <View style={styles.standingsIntroStat}>
                    <Text style={styles.standingsIntroStatText}>{pointsStat}</Text>
                </View>
            </View>
            {showBracketAction ? (
                <Pressable
                    style={styles.standingsIntroAction}
                    onPress={onOpenBracket}
                    role="button"
                    aria-label="Open playoff bracket"
                    accessibilityRole="button"
                    accessibilityLabel="Open playoff bracket"
                >
                    <Text style={styles.standingsIntroActionText}>Open Bracket</Text>
                </Pressable>
            ) : null}
        </View>
    )
}

function CompactPlayoffBracketAction({ onOpenBracket, embedded = false }: { onOpenBracket?: () => void; embedded?: boolean }) {
    if (!onOpenBracket) return null
    return (
        <Pressable
            style={[styles.standingsCompactAction, embedded && styles.standingsCompactActionEmbedded]}
            onPress={onOpenBracket}
            role="button"
            aria-label="Open playoff bracket"
            accessibilityRole="button"
            accessibilityLabel="Open playoff bracket"
        >
            <Text style={styles.standingsIntroActionText}>Open Playoff Bracket</Text>
        </Pressable>
    )
}

function CompactStandingsIntro({
    teamCount,
    status,
    showPa,
    showMaxPf,
    onOpenBracket,
    loading,
}: {
    teamCount: number
    status?: LeagueStatus
    showPa: boolean
    showMaxPf: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    const intro = standingsIntroCopy(status)
    const [recordStat, pointsStat] = standingsIntroStats(status, showPa, showMaxPf, loading)
    const teamStat = standingsTeamCountLabel(teamCount, loading)
    const accessibilityLabel = `${intro.title}. ${intro.copy} ${teamStat}. ${recordStat}. ${pointsStat}.`

    return (
        <View
            style={styles.standingsCompactIntro}
            role="group"
            aria-label={accessibilityLabel}
            aria-live="polite"
            aria-busy={loading ? true : undefined}
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: loading }}
        >
            <View style={styles.standingsCompactIntroText}>
                <Text style={styles.standingsCompactIntroTitle} numberOfLines={1}>{intro.title}</Text>
                <Text style={styles.standingsCompactIntroCopy} numberOfLines={1}>{intro.copy}</Text>
            </View>
            <View style={styles.standingsCompactStats}>
                {[teamStat, recordStat, pointsStat].map((stat) => (
                    <View key={stat} style={styles.standingsCompactStat}>
                        <Text style={styles.standingsCompactStatText} numberOfLines={1}>{stat}</Text>
                    </View>
                ))}
            </View>
            {status === 'playoffs' ? <CompactPlayoffBracketAction onOpenBracket={onOpenBracket} embedded /> : null}
        </View>
    )
}

function StandingsContextHeader({
    showMaxPf,
    showPa,
    teamCount,
    leagueStatus,
    compact,
    onOpenBracket,
    loading,
}: {
    showMaxPf: boolean
    showPa: boolean
    teamCount: number
    leagueStatus?: LeagueStatus
    compact: boolean
    onOpenBracket?: () => void
    loading?: boolean
}) {
    return (
        <>
            {compact ? (
                <CompactStandingsIntro
                    teamCount={teamCount}
                    status={leagueStatus}
                    showPa={showPa}
                    showMaxPf={showMaxPf}
                    onOpenBracket={onOpenBracket}
                    loading={loading}
                />
            ) : (
                <StandingsIntro
                    teamCount={teamCount}
                    status={leagueStatus}
                    showPa={showPa}
                    showMaxPf={showMaxPf}
                    onOpenBracket={onOpenBracket}
                    loading={loading}
                />
            )}
        </>
    )
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
    const [webViewport, setWebViewport] = useState<{ width: number; height: number } | null>(null)
    // Drop secondary point columns on narrow viewports so the Team name never
    // collapses (320px would otherwise squeeze it to a single letter).
    const { width, height } = useWindowDimensions()
    const viewportWidth = Platform.OS === 'web' && webViewport !== null ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' && webViewport !== null ? webViewport.height : height
    const compactLandscape = viewportWidth >= 600 && viewportHeight < 500
    const compactPhoneLandscape = compactLandscape && viewportWidth < 700
    const narrowRows = viewportWidth < 440 || compactPhoneLandscape
    const compactHeader = compactLandscape || narrowRows
    const showPa = viewportWidth >= 440
    const showMaxPf = viewportWidth >= 560

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])

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
                    {index > 0 ? <ItemSeparator /> : null}
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


function ActivityRow({ item, isMe, compact }: { item: TransactionRow; isMe: boolean; compact?: boolean }) {
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = TRANSACTION_LABELS[item.transactionType] ?? item.transactionType
    const avatarSize = compact ? 32 : 40
    if (item.isSystem) {
        return (
            <View style={[styles.txRow, compact && styles.txRowCompact, isMe && styles.txRowMe]}>
                <Avatar
                    name={item.title ?? item.playerName}
                    color={color}
                    size={avatarSize}
                />
                <View style={styles.txInfo}>
                    <Text style={[styles.txPlayer, compact && styles.txPlayerCompact]} numberOfLines={1}>{item.title ?? item.playerName}</Text>
                    <Text style={styles.txTeam} numberOfLines={compact ? 1 : 2}>
                        {item.body ?? item.teamName}
                        {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                    </Text>
                </View>
                <View style={styles.txRight}>
                    <Badge label={label} color={color} variant="soft" />
                    <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
                </View>
            </View>
        )
    }

    return (
        <View style={[styles.txRow, compact && styles.txRowCompact, isMe && styles.txRowMe]}>
            <Avatar
                name={item.playerName}
                color={getPositionColor(item.eligiblePositions[0] ?? item.position)}
                size={avatarSize}
                uri={playerHeadshotUrl(item.nbaId)}
            />
            <View style={styles.txInfo}>
                <View style={styles.txNameRow}>
                    <Text style={[styles.txPlayer, compact && styles.txPlayerCompact]} numberOfLines={1}>{item.playerName}</Text>
                    {item.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
                <Text style={styles.txTeam} numberOfLines={1}>
                    {item.teamName}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
            </View>
            <View style={styles.txRight}>
                <Badge label={label} color={color} variant="soft" />
                <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
            </View>
        </View>
    )
}

export function ActivityFeed({
    transactions,
    myMemberId,
    onLoadMore,
    hasMore,
    loading,
    loadingMore,
    loadMoreError,
}: {
    transactions: TransactionRow[]
    myMemberId?: string
    onLoadMore?: () => void
    hasMore?: boolean
    loading?: boolean
    loadingMore?: boolean
    loadMoreError?: string | null
}) {
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState<{ width: number; height: number } | null>(null)
    const viewportWidth = Platform.OS === 'web' && webViewport !== null ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' && webViewport !== null ? webViewport.height : height
    const compactLandscape = viewportWidth >= 600 && viewportHeight < 500

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])

    const renderItem = useCallback<ListRenderItem<TransactionRow>>(({ item }) => (
        <ActivityRow item={item} isMe={item.memberId === myMemberId} compact={compactLandscape} />
    ), [compactLandscape, myMemberId])
    const footerRetryMessage = 'League activity could not load more. Select to retry.'

    const ListFooter = loadMoreError ? (
        <Pressable
            onPress={onLoadMore}
            role="button"
            aria-label={footerRetryMessage}
            aria-live="polite"
            accessibilityRole="button"
            accessibilityLabel={footerRetryMessage}
            accessibilityLiveRegion="polite"
            style={styles.activityFooterAction}
        >
            <Text style={{ fontSize: fontSize.sm, color: colors.dangerDark, fontWeight: fontWeight.semibold }}>
                {footerRetryMessage}
            </Text>
        </Pressable>
    ) : hasMore || loadingMore ? (
        <Pressable
            onPress={onLoadMore}
            disabled={loadingMore}
            role="button"
            aria-label={loadingMore ? 'Loading more league activity' : 'Load more league activity'}
            aria-disabled={loadingMore}
            accessibilityRole="button"
            accessibilityLabel={loadingMore ? 'Loading more league activity' : 'Load more league activity'}
            accessibilityState={{ disabled: loadingMore }}
            style={styles.activityFooterAction}
        >
            <Text style={{ fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold }}>
                {loadingMore ? 'Loading...' : 'Load More'}
            </Text>
        </Pressable>
    ) : null
    const emptyState = loading
        ? {
              message: 'Loading league activity...',
              description: 'Fetching adds, drops, trades, and league updates.',
              accessibilityLabel: 'Loading league activity. Fetching adds, drops, trades, and league updates.',
          }
        : {
              message: 'No transactions yet.',
              description: 'Adds, drops, and trades are listed here.',
              accessibilityLabel: 'No league activity yet. Adds, drops, and trades are listed here.',
          }
    const ListEmpty = (
        <View
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
        <FlashList
            key={compactLandscape ? 'compact-activity' : 'activity'}
            data={transactions}
            keyExtractor={(t) => t.id}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={renderItem}
            ListFooterComponent={ListFooter}
            ListEmptyComponent={ListEmpty}
            extraData={compactLandscape}
        />
    )
}


function WaiverRow({ item, isMe, rank }: { item: WaiverPriorityRow; isMe: boolean; rank: number }) {
    return (
        <View style={[styles.waiverRow, isMe && styles.standingsRowMe]}>
            <Text style={[styles.waiverRank, isMe && styles.standingsMe]}>{rank}</Text>
            <Text style={[styles.waiverTeam, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.teamName}
            </Text>
            <Text style={[styles.waiverName, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.displayName}
            </Text>
        </View>
    )
}

const WaiverListHeader = (
    <View style={[styles.waiverRow, styles.waiverHeader]}>
        <Text style={[styles.waiverRank, styles.standingsHeaderText]}>#</Text>
        <Text style={[styles.waiverTeam, styles.standingsHeaderText]}>Team</Text>
        <Text style={[styles.waiverName, styles.standingsHeaderText]}>Manager</Text>
    </View>
)

export function WaiverPriorityList({ rows, myMemberId }: { rows: WaiverPriorityRow[]; myMemberId?: string }) {
    const renderItem = useCallback<ListRenderItem<WaiverPriorityRow>>(({ item, index }) => (
        <WaiverRow item={item} isMe={item.memberId === myMemberId} rank={index + 1} />
    ), [myMemberId])

    return (
        <FlashList
            data={rows}
            keyExtractor={(r) => r.memberId}
            ListHeaderComponent={rows.length ? WaiverListHeader : undefined}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={renderItem}
            ListEmptyComponent={<EmptyState message="No waiver priorities yet." description="Priority order is listed here once the season starts." fullScreen={false} />}
        />
    )
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
                isMine && styles.standingsRowMe,
            ]}
            role="listitem"
            aria-label={label}
            accessibilityRole="text"
            accessibilityLabel={label}
        >
            <Text
                style={[styles.picksBankRound, compact && styles.picksBankRoundCompact, narrow && styles.picksBankRoundNarrow, isMine && styles.standingsMe]}
                numberOfLines={1}
            >
                {compact ? `${pick.seasonYear} R${pick.round}` : `R${pick.round}`}
            </Text>
            <View style={[styles.picksBankFromWrap, narrow && styles.picksBankFromWrapNarrow]}>
                <Text style={[styles.picksBankFrom, isMine && styles.standingsMe]} numberOfLines={1}>
                    {compact ? <Text style={styles.picksBankInlineLabel}>From </Text> : null}
                    {pick.originalTeamName}
                </Text>
                {isTraded ? (
                    <View style={styles.picksBankTradePill}>
                        <Text style={styles.picksBankTradeText}>Traded</Text>
                    </View>
                ) : null}
            </View>
            <Text style={[styles.picksBankOwner, narrow && styles.picksBankOwnerNarrow, isMine && styles.standingsMe]} numberOfLines={1}>
                {compact ? <Text style={styles.picksBankInlineLabel}>Owner </Text> : null}
                {isMine ? 'You' : pick.currentTeamName}
            </Text>
        </View>
    )
}

function PicksBankColumns({ compact }: { compact: boolean }) {
    return (
        <View style={styles.picksBankHeader}>
            <Text style={[styles.standingsHeaderText, styles.picksBankHeaderRound, compact && styles.picksBankRoundCompact]} numberOfLines={1} accessibilityLabel="Draft round">ROUND</Text>
            <Text style={[styles.standingsHeaderText, styles.picksBankHeaderFrom]} accessibilityLabel="Original team">FROM</Text>
            <Text style={[styles.standingsHeaderText, styles.picksBankHeaderOwner]} accessibilityLabel="Current owner">OWNER</Text>
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
    const pickCountLabel = (count: number) => `${count} ${count === 1 ? 'pick' : 'picks'}`
    const pickCountState = (count: number) => loading ? 'loading' : pickCountLabel(count)
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
                        <Text style={styles.picksLedgerCompactTitle} numberOfLines={1}>Draft assets</Text>
                        <Text style={styles.picksLedgerCompactCopy} numberOfLines={1}>{compactCopy}</Text>
                    </View>
                ) : (
                    <View>
                        <Text style={styles.picksLedgerTitle}>Draft assets</Text>
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
    const [webViewportWidth, setWebViewportWidth] = useState<number | null>(null)
    const [webViewportHeight, setWebViewportHeight] = useState<number | null>(null)
    const { width, height } = useWindowDimensions()
    const viewportWidth = Platform.OS === 'web' && webViewportWidth !== null ? webViewportWidth : width
    const viewportHeight = Platform.OS === 'web' && webViewportHeight !== null ? webViewportHeight : height
    const narrowRows = viewportWidth < 440
    const compactLandscape = viewportWidth >= 600 && viewportHeight < 500
    const compactHeader = viewportHeight < 500 || narrowRows
    const compactRows = compactHeader || narrowRows
    const landscapeDenseRows = compactLandscape && !narrowRows
    const hasMemberId = Boolean(myMemberId)
    const activeFilter = effectivePickFilter(filter, hasMemberId)

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => {
            setWebViewportWidth(window.innerWidth)
            setWebViewportHeight(window.innerHeight)
        }
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])

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
