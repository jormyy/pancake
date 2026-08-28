import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MAX_TRADE_ITEMS, MAX_TRADE_PARTICIPANTS } from '@pancake/core'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import { isMultiTeamTradeSubmittable } from '@/lib/multi-team-trade-state'
import type { TradeComposerMember } from '@/lib/trade-ui-model'
import { showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import {
    buildTwoTeamTradeComposerPayload,
    getTradeComposerMode,
    prefillTradeComposerFromTrade,
    submitMultiTeamTradeComposer,
    submitTradeComposer,
    tradeComposerSuccessCopy,
    tradeComposerTitle,
    validateTradeExpirationDays,
    validateTradeNotes,
} from '@/lib/trade-composer'
import {
    counterMultiTeamTrade,
    counterTrade,
    editMultiTeamTrade,
    editTrade,
    getCurrentSeasonId,
    getTradeById,
    proposeMultiTeamTrade,
    proposeTrade,
} from '@/lib/trades'
import { takeTradeAnalyzerDraft } from '@/lib/trade-analyzer-session'

export default function ProposeTradeScreen() {
    const { current, currentLeague } = useLeagueContext()
    const params = useLocalSearchParams<{
        recipientMemberId?: string
        editTradeId?: string
        counterTradeId?: string
        requestPlayerId?: string
        requestPickId?: string
        analyzerDraftId?: string
    }>()
    const { back } = useRouter()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const [members, setMembers] = useState<TradeComposerMember[]>([])
    const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(params.recipientMemberId ?? null)
    const [multiTeamMode, setMultiTeamMode] = useState(false)
    const [notes, setNotes] = useState('')
    const [expirationDays, setExpirationDays] = useState('3')
    const [loading, setLoading] = useState(true)
    const [membersError, setMembersError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [reviewing, setReviewing] = useState(false)
    const ownerIdentity = myMemberId && leagueId ? `${leagueId}:${myMemberId}` : null
    const activeOwnerRef = useRef(ownerIdentity)
    activeOwnerRef.current = ownerIdentity
    const mountedRef = useRef(false)
    const submissionRef = useRef<{ ownerIdentity: string; token: symbol } | null>(null)
    const routePrefillKeyRef = useRef<string | null>(null)
    const analyzerDraftKeyRef = useRef<string | null>(null)
    const membersRequestRef = useRef(0)
    const { mode, editTradeId, counterTradeId, sourceTradeId } = getTradeComposerMode(params)
    const canUseMultiTeamMode = mode === 'propose'
    const faabEnabled = currentLeague?.waiver_mode === 'faab'
    const composer = useMultiTeamTradeComposer({
        enabled: Boolean(myMemberId && leagueId && (multiTeamMode || selectedRecipientId)),
        myMemberId,
        leagueId,
        myTeamName: current?.team_name ?? 'Your team',
        members,
        faabEnabled,
    })
    const {
        loadedParticipantKey,
        participantIds,
        participantViews,
        prefillFromTrade,
        prefillFromItems,
        reset,
        selectParticipantAsset,
        setParticipantIds,
        toggleParticipant,
    } = composer

    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
    }, [])

    const ownsOwner = useCallback((capturedOwner: string | null) => (
        mountedRef.current && capturedOwner !== null && activeOwnerRef.current === capturedOwner
    ), [])

    useEffect(() => {
        submissionRef.current = null
        setSubmitting(false)
        setReviewing(false)
    }, [ownerIdentity])

    const loadMembers = useCallback(async () => {
        const requestId = ++membersRequestRef.current
        if (!leagueId) {
            setMembers([])
            setMembersError(null)
            setLoading(false)
            return
        }
        setLoading(true)
        setMembersError(null)
        try {
            const all = await getLeagueMembers(leagueId)
            if (membersRequestRef.current !== requestId) return
            setMembers(all.filter((member) => member.id !== myMemberId))
        } catch (error) {
            if (membersRequestRef.current !== requestId) return
            setMembers([])
            setMembersError(getErrorMessage(error) ?? 'Could not load league members.')
        } finally {
            if (membersRequestRef.current === requestId) setLoading(false)
        }
    }, [leagueId, myMemberId])

    useEffect(() => {
        void loadMembers()
        return () => { membersRequestRef.current += 1 }
    }, [loadMembers])

    useEffect(() => {
        if (multiTeamMode || !selectedRecipientId || !myMemberId) return
        setParticipantIds([myMemberId, selectedRecipientId])
    }, [multiTeamMode, myMemberId, selectedRecipientId, setParticipantIds])

    useEffect(() => {
        if (!params.analyzerDraftId || analyzerDraftKeyRef.current === params.analyzerDraftId) return
        analyzerDraftKeyRef.current = params.analyzerDraftId
        const draft = takeTradeAnalyzerDraft(params.analyzerDraftId)
        if (!draft || draft.leagueId !== leagueId || draft.actorMemberId !== myMemberId) return
        setMultiTeamMode(draft.participantMemberIds.length > 2)
        setSelectedRecipientId(draft.participantMemberIds.length === 2
            ? draft.participantMemberIds.find((id) => id !== myMemberId) ?? null
            : null)
        prefillFromItems(draft.participantMemberIds, draft.items)
    }, [leagueId, myMemberId, params.analyzerDraftId, prefillFromItems])

    useEffect(() => {
        if (!sourceTradeId || !myMemberId) return
        const capturedOwner = ownerIdentity
        let cancelled = false
        getTradeById(sourceTradeId, myMemberId)
            .then((trade) => {
                if (cancelled || !ownsOwner(capturedOwner) || !trade) return
                const prefill = prefillTradeComposerFromTrade(mode, trade)
                setMultiTeamMode(trade.isMultiTeam)
                setSelectedRecipientId(trade.isMultiTeam ? null : prefill.selectedRecipientId)
                setNotes(prefill.notes)
                setExpirationDays(prefill.expirationDays)
                prefillFromTrade(trade, myMemberId)
            })
            .catch((error) => {
                if (!cancelled && ownsOwner(capturedOwner)) {
                    showAlert('Error', getErrorMessage(error) ?? 'Could not load trade.')
                }
            })
        return () => {
            cancelled = true
        }
    }, [mode, myMemberId, ownerIdentity, ownsOwner, prefillFromTrade, sourceTradeId])

    useEffect(() => {
        if (multiTeamMode || !selectedRecipientId || loadedParticipantKey !== participantIds.join(',')) return
        const routeKey = `${selectedRecipientId}:${params.requestPlayerId ?? ''}:${params.requestPickId ?? ''}`
        if (routePrefillKeyRef.current === routeKey) return
        const recipient = participantViews.find((participant) => participant.memberId === selectedRecipientId)
        if (!recipient) return
        if (params.requestPlayerId && recipient.roster.some((player) => player.players.id === params.requestPlayerId)) {
            selectParticipantAsset(selectedRecipientId, 'player', params.requestPlayerId)
        }
        if (params.requestPickId && recipient.picks.some((pick) => pick.pickId === params.requestPickId)) {
            selectParticipantAsset(selectedRecipientId, 'pick', params.requestPickId)
        }
        routePrefillKeyRef.current = routeKey
    }, [
        loadedParticipantKey,
        multiTeamMode,
        params.requestPickId,
        params.requestPlayerId,
        participantIds,
        participantViews,
        selectParticipantAsset,
        selectedRecipientId,
    ])

    const setMode = useCallback((useMultiTeam: boolean) => {
        if (!canUseMultiTeamMode) return
        setMultiTeamMode(useMultiTeam)
        setSelectedRecipientId(null)
        routePrefillKeyRef.current = null
        reset()
    }, [canUseMultiTeamMode, reset])

    const selectTeam = useCallback((memberId: string) => {
        if (multiTeamMode) toggleParticipant(memberId)
        else setSelectedRecipientId(memberId)
    }, [multiTeamMode, toggleParticipant])

    const items = composer.buildMultiTeamItems()
    const tradeAnalysis = useDynastyTradeAnalysis({
        enabled: composer.assetsReady,
        leagueId,
        memberId: myMemberId,
        scoringSettings: currentLeague?.scoring_settings,
        teams: Math.max(4, members.length + 1),
        faabBudget: currentLeague?.faab_starting_budget ?? 100,
        participants: composer.participantViews,
        items,
    })
    const notesError = validateTradeNotes(notes).error
    const expirationError = validateTradeExpirationDays(expirationDays).error
    const twoTeamDraft = selectedRecipientId
        ? buildTwoTeamTradeComposerPayload(items, myMemberId, selectedRecipientId, {
            notes,
            expirationDaysInput: expirationDays,
            leagueStatus: currentLeague?.status,
            tradeDeadline: currentLeague?.trade_deadline,
        })
        : null
    const tradingClosed = isTradingClosed(currentLeague)
    const withinItemLimit = items.length <= MAX_TRADE_ITEMS
    const itemLimitMessage = items.length > MAX_TRADE_ITEMS
        ? `This trade has ${items.length} items. Remove ${items.length - MAX_TRADE_ITEMS} to meet the ${MAX_TRADE_ITEMS}-item limit.`
        : items.length === MAX_TRADE_ITEMS
            ? 'Trade item limit reached. Remove an item before selecting another.'
            : null
    const participantLimitMessage = multiTeamMode && participantIds.length >= MAX_TRADE_PARTICIPANTS
        ? participantIds.length > MAX_TRADE_PARTICIPANTS
            ? `This trade has ${participantIds.length} teams. Remove ${participantIds.length - MAX_TRADE_PARTICIPANTS} to meet the ${MAX_TRADE_PARTICIPANTS}-team limit.`
            : 'Trade team limit reached. Remove a team before selecting another.'
        : null
    const canSubmit = !tradingClosed && !submitting && composer.assetsReady && withinItemLimit &&
        !notesError && !expirationError && (
        multiTeamMode
            ? isMultiTeamTradeSubmittable(participantIds, items)
            : Boolean(selectedRecipientId && twoTeamDraft?.hasOffer && twoTeamDraft.hasRequest && !twoTeamDraft.faabError)
    )

    const handleSubmit = useCallback(async () => {
        if (!ownerIdentity || !ownsOwner(ownerIdentity) || submissionRef.current || !canSubmit) return
        const submission = { ownerIdentity, token: Symbol('trade-submission') }
        submissionRef.current = submission
        setSubmitting(true)
        try {
            if (multiTeamMode) {
                await submitMultiTeamTradeComposer({
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    participantMemberIds: participantIds,
                    items,
                    notes,
                    expirationDays,
                    leagueStatus: currentLeague?.status,
                    tradeDeadline: currentLeague?.trade_deadline,
                }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })
            } else if (selectedRecipientId && twoTeamDraft) {
                await submitTradeComposer({
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    selectedRecipientId,
                    payload: twoTeamDraft.payload,
                }, { getCurrentSeasonId, proposeTrade, counterTrade, editTrade })
            }
            if (!ownsOwner(ownerIdentity) || submissionRef.current !== submission) return
            const successCopy = tradeComposerSuccessCopy(mode)
            showSuccess(successCopy.title, successCopy.message)
            back()
        } catch (error) {
            if (ownsOwner(ownerIdentity) && submissionRef.current === submission) {
                showAlert('Error', getErrorMessage(error) ?? 'Could not propose trade.')
            }
        } finally {
            if (submissionRef.current === submission) {
                submissionRef.current = null
                if (ownsOwner(ownerIdentity)) setSubmitting(false)
            }
        }
    }, [
        back,
        canSubmit,
        counterTradeId,
        currentLeague?.status,
        currentLeague?.trade_deadline,
        editTradeId,
        expirationDays,
        items,
        leagueId,
        mode,
        multiTeamMode,
        myMemberId,
        notes,
        ownerIdentity,
        ownsOwner,
        participantIds,
        selectedRecipientId,
        twoTeamDraft,
    ])

    const multiTeamBuilderProps = {
        participants: composer.participantViews,
        items,
        myMemberId,
        faabEnabled,
        notes,
        notesError,
        expirationDays,
        expirationError,
        rosterError: composer.rosterError,
        rosterLoading: composer.rosterLoading,
        avgMap: composer.avgMap,
        avgStatsMap: composer.avgStatsMap,
        participantName: composer.participantName,
        onRetry: composer.retry,
        onTogglePlayer: composer.toggleParticipantPlayer,
        onTogglePick: composer.toggleParticipantPick,
        onDestinationChange: composer.setParticipantDestination,
        onPlayerDestinationChange: composer.setParticipantPlayerDestination,
        onPickDestinationChange: composer.setParticipantPickDestination,
        onFaabChange: composer.setParticipantFaab,
        onNotesChange: setNotes,
        onExpirationDaysChange: setExpirationDays,
    }

    if (!current) {
        return (
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.emptyCenter}><Text style={styles.emptyText}>No active league.</Text></View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <View style={styles.header}>
                <View style={styles.headerInner}>
                    <Pressable onPress={back} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Cancel trade proposal">
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Text style={styles.headerTitle} numberOfLines={1}>{tradeComposerTitle(mode)}</Text>
                    <Pressable
                        onPress={() => setReviewing(true)}
                        style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                        disabled={!canSubmit}
                        accessibilityRole="button"
                        accessibilityLabel="Review trade proposal"
                        testID="trade-submit"
                        id="trade-submit"
                    >
                        <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>
                            Review
                        </Text>
                    </Pressable>
                </View>
            </View>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                {tradingClosed ? (
                    <View style={styles.lockBanner}>
                        <Text style={styles.lockBannerText}>Trades are locked only from the trade deadline until the champion is finalized.</Text>
                    </View>
                ) : null}
                {itemLimitMessage ? (
                    <View
                        style={styles.lockBanner}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        testID="trade-item-limit"
                    >
                        <Text style={styles.lockBannerText}>{itemLimitMessage}</Text>
                    </View>
                ) : null}
                {participantLimitMessage ? (
                    <View
                        style={styles.lockBanner}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        testID="trade-participant-limit"
                    >
                        <Text style={styles.lockBannerText}>{participantLimitMessage}</Text>
                    </View>
                ) : null}
                <Text style={styles.sectionLabel}>TRADE WITH</Text>
                {canUseMultiTeamMode ? (
                    <View style={styles.modeSwitch}>
                        <ModeButton label="2-Team" active={!multiTeamMode} onPress={() => setMode(false)} />
                        <ModeButton label="Multi-Team" active={multiTeamMode} onPress={() => setMode(true)} />
                    </View>
                ) : null}
                <View style={styles.teamChips}>
                    {members.map((member) => {
                        const active = multiTeamMode
                            ? composer.selectedParticipantIds.has(member.id)
                            : selectedRecipientId === member.id
                        const participantDisabled = multiTeamMode && !active &&
                            participantIds.length >= MAX_TRADE_PARTICIPANTS
                        return (
                            <Pressable
                                key={member.id}
                                style={[styles.teamChip, active && styles.teamChipActive,
                                    participantDisabled && styles.teamChipDisabled]}
                                onPress={() => selectTeam(member.id)}
                                disabled={participantDisabled}
                                accessibilityRole="button"
                                accessibilityLabel={`${active ? 'Remove' : 'Trade with'} ${member.team_name ?? 'Unnamed team'}`}
                                accessibilityState={{ selected: active, disabled: participantDisabled }}
                                testID={`trade-participant-${member.id}`}
                                id={`trade-participant-${member.id}`}
                            >
                                <Text style={[styles.teamChipText, active && styles.teamChipTextActive]} numberOfLines={2}>
                                    {member.team_name ?? 'Unnamed'}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
                {membersError ? (
                    <>
                        <ErrorBanner message={membersError} onRetry={() => { void loadMembers() }} />
                        <EmptyState icon="error-outline" message="Teams unavailable"
                            description="Retry to load the league members available for this trade."
                            fullScreen={false} framed />
                    </>
                ) : composer.participantViews.length >= 2 ? (
                    <MultiTeamTradeBuilder {...multiTeamBuilderProps} />
                ) : !loading ? (
                    <EmptyState
                        icon={multiTeamMode ? 'group-add' : 'swap-horiz'}
                        message={multiTeamMode ? 'Pick at least two more teams' : 'Pick a team to trade with'}
                        description={multiTeamMode
                            ? 'Choose teams above, then select the assets each team sends.'
                            : 'Choose a team above, then build both sides of the offer.'
                        }
                        fullScreen={false}
                        framed
                    />
                ) : null}
                <TradeAnalysisSummary analysis={tradeAnalysis.analysis} participantName={composer.participantName}
                    loading={tradeAnalysis.loading} />
                <View style={styles.bottomSpace} />
            </ScrollView>
            {reviewing ? (
                <Modal
                    visible
                    animationType="slide"
                    presentationStyle="fullScreen"
                    onRequestClose={() => setReviewing(false)}
                >
                    <SafeAreaView style={styles.container} edges={['top']}>
                        <View style={styles.header}>
                            <View style={styles.headerInner}>
                                <Pressable
                                    onPress={() => setReviewing(false)}
                                    style={styles.headerButton}
                                    accessibilityRole="button"
                                    accessibilityLabel="Back to trade editor"
                                >
                                    <Text style={styles.cancelText}>Back</Text>
                                </Pressable>
                                <Text style={styles.headerTitle} numberOfLines={1}>Review Trade</Text>
                                <Pressable
                                    onPress={handleSubmit}
                                    style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                                    disabled={!canSubmit}
                                    accessibilityRole="button"
                                    accessibilityLabel="Confirm and send trade"
                                    testID="trade-confirm-submit"
                                    id="trade-confirm-submit"
                                >
                                    <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>Confirm</Text>
                                </Pressable>
                            </View>
                        </View>
                        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                            <TradeAnalysisSummary analysis={tradeAnalysis.analysis} participantName={composer.participantName}
                                loading={tradeAnalysis.loading} />
                            <MultiTeamTradeBuilder {...multiTeamBuilderProps} reviewOnly />
                        </ScrollView>
                    </SafeAreaView>
                </Modal>
            ) : null}
        </SafeAreaView>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    return (
        <Pressable
            style={[styles.modeButton, active && styles.modeButtonActive]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Use ${label.toLowerCase()} trade mode`}
            accessibilityState={{ selected: active }}
            testID={label === 'Multi-Team' ? 'trade-mode-multi' : 'trade-mode-two'}
            id={label === 'Multi-Team' ? 'trade-mode-multi' : 'trade-mode-two'}
        >
            <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>{label}</Text>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },
    scrollContent: { width: '100%', maxWidth: 900, minWidth: 0, alignSelf: 'center' },
    header: { paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 900,
        alignSelf: 'center',
    },
    headerTitle: {
        flex: 1,
        marginHorizontal: spacing.md,
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
    },
    headerButton: {
        minWidth: 72,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    cancelText: { fontSize: fontSize.lg, color: colors.textSecondary },
    submitButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        minHeight: 44,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 72,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButtonDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight, opacity: 0.55 },
    submitText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    submitTextDisabled: { color: colors.textPlaceholder },
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    modeSwitch: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
    modeButton: {
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
        alignItems: 'center',
    },
    modeButtonActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    modeButtonText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
    modeButtonTextActive: { color: colors.textWhite },
    teamChips: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xs, gap: spacing.md, flexDirection: 'row', flexWrap: 'wrap' },
    teamChip: {
        paddingHorizontal: 14,
        minHeight: 44,
        maxWidth: '100%',
        flexShrink: 1,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipDisabled: { opacity: 0.45 },
    teamChipText: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary, textAlign: 'center' },
    teamChipTextActive: { color: colors.textWhite },
    lockBanner: {
        marginHorizontal: spacing.xl,
        marginTop: spacing.xl,
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.warningDark,
        backgroundColor: colors.warningLight,
    },
    lockBannerText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.warningDark, textAlign: 'center' },
    emptyCenter: { alignItems: 'center', padding: spacing['5xl'] },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
    bottomSpace: { height: 40 },
})
