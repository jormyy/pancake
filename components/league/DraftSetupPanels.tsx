import { View, Text, Pressable, StyleSheet, ScrollView, useWindowDimensions } from 'react-native'
import {
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import type { LeaguePickItem } from '@/lib/rookieDraft'
import { spacing } from '@/constants/tokens'
import {
    DraftChips,
    DraftTimerControl,
    NOMINATION_ORDER_CHIPS,
    ROOKIE_ROUND_CHIPS,
    ROOKIE_TIMER_EXPIRY_CHIPS,
    rookieRoundChipLabel,
    type DraftControlProps,
} from '@/components/league/DraftChips'
import type { DraftTimerOption, RookieRoundOption } from '@/lib/draft-options'
import { ActiveDraftEntry, ActiveDraftErrorNotice, DraftPrepNotice } from '@/components/league/DraftActiveState'
import { panelStyles } from '@/components/league/draftPanelStyles'
import { PicksBankList } from '@/components/league/LeaguePicksBank'
import type { LeagueStatus } from '@/types/database'

function auctionStartButtonLabel(draftTimerSeconds: DraftTimerOption, nominationMode: NominationOrderMode) {
    return `Start auction draft, ${draftTimerSeconds} second timer, ${NOMINATION_ORDER_MODE_LABELS[nominationMode]} nomination order`
}

function rookieStartButtonLabel(
    rookieRounds: RookieRoundOption,
    draftTimerSeconds: DraftTimerOption,
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior,
) {
    return `Start rookie draft, ${rookieRounds} rounds, ${draftTimerSeconds} second timer, ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior]} timeout behavior`
}

function draftBoardSetupMaxHeight(width: number, height: number) {
    if (height < 500) return 64
    if (width < 600) return 144
    return 188
}

export function AuctionPanel({
    activeDraft,
    activeDraftLoading,
    currentLeagueStatus,
    isCommissioner,
    draftLoading,
    activeDraftError,
    onRetryActiveDraft,
    nominationMode,
    onNominationModeChange,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    onStartDraft,
    onJoinDraft,
    onReseedRookiePicks,
    onOpenDraftBoard,
}: Pick<DraftControlProps, 'nominationMode' | 'onNominationModeChange' | 'draftTimerSeconds' | 'onDraftTimerSecondsChange'> & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: LeagueStatus
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    onStartDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
    onOpenDraftBoard?: () => void
}) {
    const { height } = useWindowDimensions()
    const compactSetup = height < 500
    const activeDraftReady = !activeDraftLoading && !activeDraftError
    const hasActiveAuction = activeDraftReady && activeDraft?.draftType === 'auction'
    const canStartAuction = activeDraftReady && currentLeagueStatus === 'setup' && isCommissioner
    const startAuctionAccessibilityLabel = auctionStartButtonLabel(draftTimerSeconds, nominationMode)

    const startButton = (
        <Pressable
            style={[panelStyles.draftButton, compactSetup && styles.auctionCompactStartButton]}
            onPress={onStartDraft}
            disabled={draftLoading}
            role="button"
            aria-label={startAuctionAccessibilityLabel}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={startAuctionAccessibilityLabel}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={panelStyles.draftButtonText}>Start Auction Draft</Text>
        </Pressable>
    )

    return (
        <ScrollView contentContainerStyle={[
            panelStyles.panelScroll,
            compactSetup && panelStyles.panelScrollCompactLandscape,
            compactSetup && (hasActiveAuction || canStartAuction) && styles.activeDraftPanelScrollCompact,
        ]}>
            <ActiveDraftErrorNotice activeDraftError={activeDraftError} onRetryActiveDraft={onRetryActiveDraft} />
            <ActiveDraftEntry
                activeDraft={activeDraft}
                activeDraftLoading={activeDraftLoading}
                isCommissioner={isCommissioner}
                draftLoading={draftLoading}
                filterType="auction"
                onJoinDraft={onJoinDraft}
                onReseedRookiePicks={onReseedRookiePicks}
            />
            {canStartAuction ? (
                <View style={[panelStyles.panelCard, compactSetup && panelStyles.panelCardCompact, compactSetup && styles.auctionPanelCardCompact]}>
                    {compactSetup ? null : <Text style={panelStyles.panelTitle}>Auction</Text>}
                    {compactSetup ? (
                        <>
                            <View style={styles.auctionCompactStartRow}>
                                <View style={styles.auctionCompactTimerWrap}>
                                    <DraftTimerControl
                                        selectedValue={draftTimerSeconds}
                                        onSelect={onDraftTimerSecondsChange}
                                        groupLabel="Auction draft timer"
                                        compact
                                    />
                                </View>
                                {startButton}
                            </View>
                            <Text style={[panelStyles.nominationModeLabel, styles.auctionCompactLabel]}>Nomination order</Text>
                            <DraftChips
                                options={NOMINATION_ORDER_CHIPS}
                                selectedValue={nominationMode}
                                onSelect={onNominationModeChange}
                                groupLabel="Nomination order"
                                compact
                            />
                        </>
                    ) : (
                        <>
                            <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                            <DraftTimerControl
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Auction draft timer"
                            />
                            <Text style={panelStyles.nominationModeLabel}>Nomination order</Text>
                            <DraftChips
                                options={NOMINATION_ORDER_CHIPS}
                                selectedValue={nominationMode}
                                onSelect={onNominationModeChange}
                                groupLabel="Nomination order"
                            />
                            {startButton}
                        </>
                    )}
                </View>
            ) : null}
            {activeDraftReady && !hasActiveAuction && !canStartAuction ? (
                <DraftPrepNotice kind="auction" status={currentLeagueStatus} compact={compactSetup} onOpenDraftBoard={onOpenDraftBoard} />
            ) : null}
        </ScrollView>
    )
}

export function DraftBoardPanel({
    activeDraft,
    activeDraftLoading,
    currentLeagueStatus,
    isCommissioner,
    draftLoading,
    activeDraftError,
    onRetryActiveDraft,
    picks,
    picksLoading,
    myMemberId,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    rookieRounds,
    onRookieRoundsChange,
    rookieTimerExpiryBehavior,
    onRookieTimerExpiryBehaviorChange,
    onStartRookieDraft,
    onJoinDraft,
    onReseedRookiePicks,
}: Pick<DraftControlProps, 'draftTimerSeconds' | 'onDraftTimerSecondsChange' | 'rookieRounds' | 'onRookieRoundsChange' | 'rookieTimerExpiryBehavior' | 'onRookieTimerExpiryBehaviorChange'> & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: LeagueStatus
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    picks: LeaguePickItem[]
    picksLoading?: boolean
    myMemberId?: string
    onStartRookieDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}) {
    const { width, height } = useWindowDimensions()
    const compactRookieSetup = height < 500
    const constrainBoardTop = width < 600 || height < 500
    const compactRookiePrepNotice = constrainBoardTop
    const boardTopMaxHeight = draftBoardSetupMaxHeight(width, height)
    const activeDraftReady = !activeDraftLoading && !activeDraftError
    const hasActiveRookieDraft = activeDraftReady && activeDraft?.draftType === 'snake'
    const canStartRookieDraft = activeDraftReady && currentLeagueStatus === 'offseason' && isCommissioner
    const showRookiePrepNotice = !picksLoading && activeDraftReady && activeDraft?.draftType !== 'snake' && picks.length === 0
    const showBoardTop = Boolean(activeDraftError) || hasActiveRookieDraft || canStartRookieDraft || showRookiePrepNotice
    const startRookieAccessibilityLabel = rookieStartButtonLabel(rookieRounds, draftTimerSeconds, rookieTimerExpiryBehavior)

    const startRookieButton = (
        <Pressable
            style={[panelStyles.draftButton, compactRookieSetup && styles.rookieCompactStartButton]}
            onPress={onStartRookieDraft}
            disabled={draftLoading}
            role="button"
            aria-label={startRookieAccessibilityLabel}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={startRookieAccessibilityLabel}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={panelStyles.draftButtonText}>Start Rookie Draft</Text>
        </Pressable>
    )

    const boardTop = (
        <>
            <ActiveDraftErrorNotice activeDraftError={activeDraftError} onRetryActiveDraft={onRetryActiveDraft} />
            <ActiveDraftEntry
                activeDraft={activeDraft}
                activeDraftLoading={activeDraftLoading}
                isCommissioner={isCommissioner}
                draftLoading={draftLoading}
                filterType="snake"
                onJoinDraft={onJoinDraft}
                onReseedRookiePicks={onReseedRookiePicks}
            />
            {canStartRookieDraft ? (
                <View style={[panelStyles.panelCard, compactRookieSetup && panelStyles.panelCardCompact]}>
                    {compactRookieSetup ? null : <Text style={panelStyles.panelTitle}>Rookie Draft</Text>}
                    {compactRookieSetup ? (
                        <>
                            <View style={styles.rookieCompactStartRow}>
                                <View style={styles.rookieCompactRoundsWrap}>
                                    <DraftChips
                                        options={ROOKIE_ROUND_CHIPS}
                                        selectedValue={rookieRounds}
                                        onSelect={onRookieRoundsChange}
                                        groupLabel="Rookie draft rounds"
                                        accessibilityLabelForOption={rookieRoundChipLabel}
                                        compact
                                    />
                                </View>
                                {startRookieButton}
                            </View>
                            <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                            <DraftTimerControl
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Rookie draft timer"
                                compact
                            />
                            <Text style={panelStyles.nominationModeLabel}>Timeout behavior</Text>
                            <DraftChips
                                options={ROOKIE_TIMER_EXPIRY_CHIPS}
                                selectedValue={rookieTimerExpiryBehavior}
                                onSelect={onRookieTimerExpiryBehaviorChange}
                                groupLabel="Rookie timeout behavior"
                                compact
                            />
                        </>
                    ) : (
                        <>
                            <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                            <DraftTimerControl
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Rookie draft timer"
                            />
                            <Text style={panelStyles.nominationModeLabel}>Rookie rounds</Text>
                            <DraftChips
                                options={ROOKIE_ROUND_CHIPS}
                                selectedValue={rookieRounds}
                                onSelect={onRookieRoundsChange}
                                groupLabel="Rookie draft rounds"
                                accessibilityLabelForOption={rookieRoundChipLabel}
                            />
                            <Text style={panelStyles.nominationModeLabel}>Timeout behavior</Text>
                            <DraftChips
                                options={ROOKIE_TIMER_EXPIRY_CHIPS}
                                selectedValue={rookieTimerExpiryBehavior}
                                onSelect={onRookieTimerExpiryBehaviorChange}
                                groupLabel="Rookie timeout behavior"
                            />
                            {startRookieButton}
                        </>
                    )}
                </View>
            ) : null}
            {showRookiePrepNotice ? (
                <DraftPrepNotice kind="rookie" status={currentLeagueStatus} compact={compactRookiePrepNotice} />
            ) : null}
        </>
    )

    return (
        <View style={styles.boardWrap}>
            {showBoardTop ? (
                constrainBoardTop ? (
                    <ScrollView
                        style={[styles.boardTopScroll, { maxHeight: boardTopMaxHeight }]}
                        showsVerticalScrollIndicator
                    >
                        <View style={[styles.boardTop, styles.boardTopConstrained]}>
                            {boardTop}
                        </View>
                    </ScrollView>
                ) : (
                    <View style={styles.boardTop}>
                        {boardTop}
                    </View>
                )
            ) : null}
            <View style={styles.boardList}>
                <PicksBankList
                    picks={picks}
                    myMemberId={myMemberId}
                    loading={picksLoading}
                    leagueStatus={currentLeagueStatus}
                />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    activeDraftPanelScrollCompact: { paddingTop: spacing.xs },
    auctionPanelCardCompact: {
        paddingTop: 0,
        paddingBottom: spacing.xs,
        gap: 0,
    },
    auctionCompactLabel: { marginTop: spacing.xs, marginBottom: 0 },
    auctionCompactStartRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    auctionCompactTimerWrap: {
        flex: 1,
        minWidth: 0,
    },
    auctionCompactStartButton: {
        flexBasis: 184,
        flexShrink: 0,
    },
    rookieCompactStartRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    rookieCompactRoundsWrap: {
        flex: 1,
        minWidth: 0,
    },
    rookieCompactStartButton: {
        flexBasis: 184,
        flexShrink: 0,
    },
    boardWrap: { flex: 1 },
    boardTop: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    boardTopConstrained: {
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.sm,
    },
    boardTopScroll: { flexShrink: 0 },
    boardList: { flex: 1 },
})
