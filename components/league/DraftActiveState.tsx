import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import type { Draft } from '@/lib/draft'
import type { LeagueStatus } from '@/types/database'
import { controlSize, colors, fontWeight, radii, spacing, typeScale } from '@/constants/tokens'
import { panelStyles } from '@/components/league/draftPanelStyles'

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])

type ActiveDraftProps = {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    leagueStatus?: LeagueStatus
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

function activeDraftButtonLabel(draft: Draft, leagueStatus?: LeagueStatus) {
    const mock = draft.isMock ? 'Mock ' : ''
    const kind = draft.draftType === 'snake' ? 'Rookie Draft' : 'Auction Draft'
    if (draft.status === 'completed' && draft.draftType === 'snake') {
        return leagueStatus === 'drafting' ? 'Resolve Rookie Draft' : 'View Rookie Draft Results'
    }
    return `${draft.status === 'paused' ? 'Resume' : 'Join'} ${mock}${kind}`
}

function activeDraftTitle(draft: Draft) {
    if (draft.status === 'completed') return 'Draft Results'
    if (draft.status === 'pending') return 'Upcoming Draft'
    return 'Live Draft'
}

export function ActiveDraftEntry({
    activeDraft,
    activeDraftLoading,
    leagueStatus,
    isCommissioner,
    draftLoading,
    filterType,
    onJoinDraft,
    onReseedRookiePicks,
}: ActiveDraftProps) {
    const { height } = useWindowDimensions()
    const compactActiveDraft = height < 500

    // No loading placeholder — the card renders only once the draft status is
    // known, so nothing collapses or shifts when the fetch resolves.
    if (activeDraftLoading) {
        return null
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
            aria-label={activeDraftButtonLabel(activeDraft, leagueStatus)}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={activeDraftButtonLabel(activeDraft, leagueStatus)}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={panelStyles.draftButtonText} numberOfLines={1}>{activeDraftButtonLabel(activeDraft, leagueStatus)}</Text>
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
                    <Text style={[panelStyles.panelTitle, styles.activeDraftCompactTitle]} numberOfLines={1}>{activeDraftTitle(activeDraft)}</Text>
                    {joinButton}
                    {syncButton}
                </View>
            </View>
        )
    }

    return (
        <View style={panelStyles.panelCard}>
            <Text style={panelStyles.panelTitle}>{activeDraftTitle(activeDraft)}</Text>
            {joinButton}
            {showSyncPicks ? (
                <View style={styles.syncWrap}>
                    {syncButton}
                    <Text style={styles.syncHint}>Adds picks traded since the last sync.</Text>
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

const styles = StyleSheet.create({
    errorNotice: {
        backgroundColor: colors.dangerLight,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        minHeight: controlSize.minTouch,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorNoticeText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.dangerDark },
    activeDraftCompactRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    activeDraftCardCompact: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xxs,
        gap: spacing.none,
    },
    activeDraftCompactTitle: {
        ...typeScale.small,
        alignSelf: 'center',
        minWidth: 70,
        maxWidth: 96,
    },
    activeDraftCompactButton: {
        flex: 1,
        flexShrink: 1,
        minWidth: 0,
    },
    syncWrap: { gap: spacing.xs, marginTop: spacing.md },
    syncHint: { ...typeScale.small, color: colors.textMuted, paddingHorizontal: spacing.xs },
})
