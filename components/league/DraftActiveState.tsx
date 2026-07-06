import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import type { Draft } from '@/lib/draft'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { panelStyles } from '@/components/league/draftPanelStyles'
import type { LeagueStatus } from '@/types/database'

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])

type ActiveDraftProps = {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    isCommissioner: boolean
    draftLoading: boolean
    filterType?: 'auction' | 'snake'
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}

type ActiveDraftErrorProps = {
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
}

function activeDraftButtonLabel(draft: Draft) {
    const mock = draft.isMock ? 'Mock ' : ''
    const kind = draft.draftType === 'snake' ? 'Rookie Draft' : 'Auction Draft'
    if (draft.status === 'completed' && draft.draftType === 'snake') return 'Resolve Rookie Draft'
    return `${draft.status === 'paused' ? 'Resume' : 'Join'} ${mock}${kind}`
}

function ActiveDraftLoadingNotice({
    compact,
}: {
    compact: boolean
    filterType?: 'auction' | 'snake'
}) {
    const accessibilityLabel = 'Draft status updating.'
    return (
        <View
            style={[styles.draftLoadingNotice, compact && styles.draftLoadingNoticeCompact]}
            role="status"
            aria-label={accessibilityLabel}
            aria-busy
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ busy: true }}
        >
            <View style={styles.draftLoadingTitlePlaceholder} />
            {compact ? null : <View style={styles.draftLoadingTextPlaceholder} />}
        </View>
    )
}

export function ActiveDraftEntry({
    activeDraft,
    activeDraftLoading,
    isCommissioner,
    draftLoading,
    filterType,
    onJoinDraft,
    onReseedRookiePicks,
}: ActiveDraftProps) {
    const { height } = useWindowDimensions()
    const compactActiveDraft = height < 500

    if (activeDraftLoading) {
        return <ActiveDraftLoadingNotice compact={compactActiveDraft} filterType={filterType} />
    }

    if (!activeDraft || (filterType && activeDraft.draftType !== filterType)) {
        return null
    }

    const showSyncPicks = OPEN_DRAFT_STATUSES.has(activeDraft.status) && activeDraft.draftType === 'snake' && !activeDraft.isMock && isCommissioner
    const joinButton = (
        <Pressable
            style={[panelStyles.draftButton, compactActiveDraft && styles.activeDraftCompactButton]}
            onPress={onJoinDraft}
            disabled={draftLoading}
            role="button"
            aria-label={activeDraftButtonLabel(activeDraft)}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={activeDraftButtonLabel(activeDraft)}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={panelStyles.draftButtonText} numberOfLines={1}>{activeDraftButtonLabel(activeDraft)}</Text>
        </Pressable>
    )
    const syncButton = showSyncPicks ? (
        <Pressable
            style={[panelStyles.secondaryDraftButton, compactActiveDraft && styles.activeDraftCompactButton]}
            onPress={onReseedRookiePicks}
            disabled={draftLoading}
            role="button"
            aria-label="Sync traded picks"
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel="Sync traded picks"
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={panelStyles.secondaryDraftButtonText} numberOfLines={1}>Sync Traded Picks</Text>
        </Pressable>
    ) : null

    if (compactActiveDraft) {
        return (
            <View style={[panelStyles.panelCard, panelStyles.panelCardCompact, styles.activeDraftCardCompact]}>
                <View style={styles.activeDraftCompactRow}>
                    <Text style={[panelStyles.panelTitle, styles.activeDraftCompactTitle]} numberOfLines={1}>Live Draft</Text>
                    {joinButton}
                    {syncButton}
                </View>
            </View>
        )
    }

    return (
        <View style={panelStyles.panelCard}>
            <Text style={panelStyles.panelTitle}>Live Draft</Text>
            {joinButton}
            {showSyncPicks ? (
                <View style={styles.syncWrap}>
                    {syncButton}
                    <Text style={styles.syncHint}>Commissioner only - pull in picks acquired via trade so the draft board is current.</Text>
                </View>
            ) : null}
        </View>
    )
}

export function ActiveDraftErrorNotice({ activeDraftError, onRetryActiveDraft }: ActiveDraftErrorProps) {
    if (!activeDraftError) return null
    const message = 'Live draft status could not refresh. Select to retry.'
    return (
        <Pressable
            style={styles.errorNotice}
            onPress={onRetryActiveDraft}
            role="button"
            aria-label={message}
            aria-live="polite"
            accessibilityRole="button"
            accessibilityLabel={message}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.errorNoticeText}>{message}</Text>
        </Pressable>
    )
}

export function DraftPrepNotice({
    kind,
    status,
    compact = false,
    onOpenDraftBoard,
}: {
    kind: 'auction' | 'rookie'
    status?: LeagueStatus
    compact?: boolean
    onOpenDraftBoard?: () => void
}) {
    const auctionFinished = kind === 'auction' && (status === 'active' || status === 'playoffs')
    const title = kind === 'rookie'
        ? 'Rookie draft prep'
        : auctionFinished ? 'Auction complete' : 'Startup auction'
    const body = (() => {
        if (status === 'drafting') {
            return kind === 'auction'
                ? 'The league is drafting now. If the room is missing, refresh the active draft card above.'
                : 'A draft is in progress. Pick ownership below remains available while rosters update.'
        }
        if (status === 'active' || status === 'playoffs') {
            return kind === 'auction'
                ? "The startup auction finished before the season. Draft results live on each team's roster."
                : 'Future rookie picks remain visible during the live season for trades and long-term planning.'
        }
        if (status === 'offseason') {
            return kind === 'auction'
                ? 'The league is past the startup auction.'
                : 'Pick ownership below is the source of truth before the rookie draft clock starts.'
        }
        if (status === 'archived') {
            return kind === 'auction'
                ? 'This league is archived, so the startup auction is preserved as league history.'
                : 'Future pick ownership is preserved with league history, including traded picks.'
        }
        return kind === 'auction'
            ? 'Commissioners can start the auction from setup; managers can still review league state before the clock starts.'
            : 'Future pick ownership is visible before the draft room opens, including traded picks.'
    })()
    const accessibilityLabel = `${title}. ${body}`
    const showDraftBoardAction = auctionFinished && !compact && Boolean(onOpenDraftBoard)

    return (
        <View
            style={[styles.prepNotice, compact && styles.prepNoticeCompact]}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            accessibilityRole="summary"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
        >
            <Text style={[styles.prepNoticeTitle, compact && styles.prepNoticeTitleCompact]} numberOfLines={compact ? 1 : undefined}>
                {title}
            </Text>
            <Text style={[styles.prepNoticeText, compact && styles.prepNoticeTextCompact]} numberOfLines={compact ? 1 : undefined}>
                {body}
            </Text>
            {showDraftBoardAction ? (
                <Pressable
                    style={[panelStyles.secondaryDraftButton, styles.prepNoticeAction]}
                    onPress={onOpenDraftBoard}
                    role="button"
                    aria-label="View Draft Board"
                    accessibilityRole="button"
                    accessibilityLabel="View Draft Board"
                >
                    <Text style={panelStyles.secondaryDraftButtonText}>View Draft Board</Text>
                </Pressable>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    errorNotice: {
        backgroundColor: colors.dangerLight,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorNoticeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },
    draftLoadingNotice: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        gap: spacing.xs,
    },
    draftLoadingNoticeCompact: {
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: spacing.sm,
    },
    draftLoadingTitlePlaceholder: {
        width: 164,
        height: 14,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
    draftLoadingTextPlaceholder: {
        width: '68%',
        maxWidth: 340,
        height: 11,
        borderRadius: radii.xs,
        backgroundColor: colors.bgSubtle,
    },
    activeDraftCompactRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    activeDraftCardCompact: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xxs,
        gap: 0,
    },
    activeDraftCompactTitle: {
        alignSelf: 'center',
        minWidth: 70,
        maxWidth: 96,
        fontSize: fontSize.sm,
        lineHeight: 18,
    },
    activeDraftCompactButton: {
        flex: 1,
        minWidth: 0,
    },
    prepNotice: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: spacing.xs,
    },
    prepNoticeCompact: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        gap: spacing.sm,
    },
    prepNoticeTitle: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    prepNoticeTitleCompact: {
        flexShrink: 0,
        fontSize: fontSize.sm,
        lineHeight: 18,
    },
    prepNoticeText: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textSecondary,
    },
    prepNoticeTextCompact: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.xs,
        lineHeight: 16,
    },
    prepNoticeAction: {
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.xl,
        marginTop: spacing.sm,
    },
    syncWrap: { gap: spacing.xs, marginTop: spacing.md },
    syncHint: { fontSize: fontSize.xs, color: colors.textMuted, paddingHorizontal: spacing.xs, lineHeight: 15 },
})
