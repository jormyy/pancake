import { invalidateSeasonCache } from '@/lib/shared/season'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { uuid } from 'expo-modules-core'
import { SafeAreaView } from 'react-native-safe-area-context'

import { MAX_TRADE_ITEMS, MAX_TRADE_PARTICIPANTS } from '@pancake/core'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { colors, fontSize, fontWeight, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { PageHeader, usePageMetrics } from '@/components/ui/Page'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import { isMultiTeamTradeSubmittable } from '@/lib/multi-team-trade-state'
import type { TradeComposerMember } from '@/lib/trade-ui-model'
import { confirmAction, showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage, RequestError } from '@/lib/shared/errors'
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
import { clearTradeComposerDraft, readTradeComposerDraft, saveTradeComposerDraft } from '@/lib/trade-composer-draft'
import { useGoBack } from '@/components/ui/useGoBack'

// Inside the web shell the page is already clear of the notch; only native needs the inset.
function PageFrame({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
    return Platform.OS === 'web'
        ? <View style={style}>{children}</View>
        : <SafeAreaView style={style} edges={['top']}>{children}</SafeAreaView>
}

// The builder needs this width to show team columns side by side.
const BUILDER_WIDTH = 900

export default function ProposeTradeScreen() {
    const { user } = useAuth()
    const { current, currentLeague, online } = useLeagueContext()
    const { usableWidth } = usePageMetrics()
    // The verdict moves beside the builder only when the builder keeps its columns.
    const sideBySide = usableWidth >= BUILDER_WIDTH + layout.railWidth
    const params = useLocalSearchParams<{
        recipientMemberId?: string
        editTradeId?: string
        counterTradeId?: string
        requestPlayerId?: string
        requestPickId?: string
        analyzerDraftId?: string
    }>()
    const back = useGoBack('/trades')
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
    // The sender tab outlives the editor so Review and back lands on the same side.
    const [senderTab, setSenderTab] = useState<string | undefined>(undefined)
    const ownerIdentity = user?.id && myMemberId && leagueId ? `${user.id}:${leagueId}:${myMemberId}` : null
    const activeOwnerRef = useRef(ownerIdentity)
    activeOwnerRef.current = ownerIdentity
    const mountedRef = useRef(false)
    const submissionRef = useRef<{ ownerIdentity: string; token: symbol } | null>(null)
    const retainedAttemptRef = useRef<{ ownerIdentity: string; intent: string; send: () => Promise<void> } | null>(null)
    const routePrefillKeyRef = useRef<string | null>(null)
    const analyzerDraftKeyRef = useRef<string | null>(null)
    const membersRequestRef = useRef(0)
    // The owner whose unsent trade this editor holds; a later owner never inherits it.
    const draftOwnerRef = useRef<string | null>(null)
    const restoredDraftRef = useRef(false)
    const [draftReady, setDraftReady] = useState(false)
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
        retainedAttemptRef.current = null
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

    // A page reload (an app update reloads the page) brings back the trade this tab had not sent.
    useEffect(() => {
        if (draftOwnerRef.current !== null) {
            const sameOwner = draftOwnerRef.current === ownerIdentity
            if (!sameOwner) clearTradeComposerDraft()
            setDraftReady(sameOwner)
            return
        }
        if (!ownerIdentity) return
        draftOwnerRef.current = ownerIdentity
        const draft = readTradeComposerDraft(ownerIdentity, mode, sourceTradeId)
        if (draft) {
            restoredDraftRef.current = true
            setMultiTeamMode(draft.multiTeamMode)
            setSelectedRecipientId(draft.selectedRecipientId)
            setNotes(draft.notes)
            setExpirationDays(draft.expirationDays)
            prefillFromItems(draft.participantIds, draft.items)
            // The requested asset was already applied before the reload; the user may have removed it since.
            routePrefillKeyRef.current = `${draft.selectedRecipientId}:${params.requestPlayerId ?? ''}:${params.requestPickId ?? ''}`
        }
        setDraftReady(true)
    }, [mode, ownerIdentity, params.requestPickId, params.requestPlayerId, prefillFromItems, sourceTradeId])

    // Closing the editor ends the draft. A reload skips this cleanup, which is what keeps the draft.
    useEffect(() => clearTradeComposerDraft, [])

    useEffect(() => {
        if (!sourceTradeId || !myMemberId) return
        const capturedOwner = ownerIdentity
        let cancelled = false
        getTradeById(sourceTradeId, myMemberId)
            .then((trade) => {
                if (cancelled || !ownsOwner(capturedOwner) || !trade || restoredDraftRef.current) return
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
    // Leaving drops a built trade, so ask first once anything is selected.
    const leave = () => {
        if (items.length === 0) back()
        else confirmAction('Discard this trade?', 'The players and picks you picked will be cleared.', back, 'Discard')
    }
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
    const intent = JSON.stringify({ ownerIdentity, mode, sourceTradeId, multiTeamMode, selectedRecipientId,
        participantIds, items, notes, expirationDays })
    const retainedAttempt = retainedAttemptRef.current?.ownerIdentity === ownerIdentity &&
        retainedAttemptRef.current.intent === intent ? retainedAttemptRef.current : null
    useEffect(() => {
        if (retainedAttemptRef.current?.intent !== intent) retainedAttemptRef.current = null
    }, [intent])
    // Once Send starts, or a sent request's outcome is unknown, the server owns the trade: a restored
    // copy would send again under a new request key.
    const draftToKeep = draftReady && draftOwnerRef.current === ownerIdentity && !submitting && !retainedAttempt &&
        (items.length > 0 || notes !== '') ? intent : null
    useEffect(() => {
        if (!draftReady) return
        if (draftToKeep) saveTradeComposerDraft(draftToKeep)
        else clearTradeComposerDraft()
    }, [draftReady, draftToKeep])
    const canSubmitNew = !tradingClosed && composer.selectedAssetsAvailable && withinItemLimit &&
        !notesError && !expirationError && (
        multiTeamMode
            ? isMultiTeamTradeSubmittable(participantIds, items)
            : Boolean(selectedRecipientId && twoTeamDraft?.hasOffer && twoTeamDraft.hasRequest && !twoTeamDraft.faabError)
    )
    const canSubmit = online && !submitting && Boolean(retainedAttempt || canSubmitNew)

    const handleSubmit = useCallback(async () => {
        if (!ownerIdentity || !ownsOwner(ownerIdentity) || submissionRef.current || !canSubmit) return
        const submission = { ownerIdentity, token: Symbol('trade-submission') }
        submissionRef.current = submission
        setSubmitting(true)
        try {
            let attempt = retainedAttemptRef.current
            if (attempt?.ownerIdentity !== ownerIdentity || attempt.intent !== intent) attempt = null
            if (!attempt) {
                const requestId = uuid.v4()
                let seasonId: string | null = null
                const resolvedSeason = async () => {
                    if (!seasonId) seasonId = await getCurrentSeasonId(leagueId)
                    return seasonId
                }
                let send: () => Promise<void>
                if (multiTeamMode) {
                    const input = {
                        requestId,
                        nowMs: Date.now(),
                        mode,
                        editTradeId,
                        counterTradeId,
                        myMemberId,
                        leagueId,
                        participantMemberIds: [...participantIds],
                        items: items.map((item) => ({ ...item })),
                        notes,
                        expirationDays,
                        leagueStatus: currentLeague?.status,
                        tradeDeadline: currentLeague?.trade_deadline,
                    }
                    send = () => submitMultiTeamTradeComposer(input,
                        { getCurrentSeasonId: resolvedSeason, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })
                } else {
                    if (!selectedRecipientId || !twoTeamDraft) return
                    const payload = twoTeamDraft.payload
                    const input = {
                        requestId,
                        mode,
                        editTradeId,
                        counterTradeId,
                        myMemberId,
                        leagueId,
                        selectedRecipientId,
                        payload: { ...payload, offerPlayerIds: [...payload.offerPlayerIds], requestPlayerIds: [...payload.requestPlayerIds],
                            offerPickIds: [...payload.offerPickIds], requestPickIds: [...payload.requestPickIds] },
                    }
                    send = () => submitTradeComposer(input,
                        { getCurrentSeasonId: resolvedSeason, proposeTrade, counterTrade, editTrade })
                }
                attempt = { ownerIdentity, intent, send }
                retainedAttemptRef.current = attempt
            }
            await attempt.send()
            if (!ownsOwner(ownerIdentity) || submissionRef.current !== submission) return
            retainedAttemptRef.current = null
            clearTradeComposerDraft()
            const successCopy = tradeComposerSuccessCopy(mode)
            showSuccess(successCopy.title, successCopy.message)
            back()
        } catch (error) {
            if (ownsOwner(ownerIdentity) && submissionRef.current === submission) {
                // Rule and input rejections roll this request back. A conflicting receipt can be committed.
                const rejected = error instanceof RequestError && (error.code === 'P0001' ||
                    (error.code === '22023' && error.message !== 'This request key already belongs to different trade terms.'))
                if (rejected) {
                    retainedAttemptRef.current = null
                    invalidateSeasonCache(leagueId)
                }
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
        intent,
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
        activeParticipantId: senderTab,
        onActiveParticipantChange: setSenderTab,
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
        onRemoveAsset: composer.removeParticipantAsset,
        onDestinationChange: composer.setParticipantDestination,
        onPlayerDestinationChange: composer.setParticipantPlayerDestination,
        onPickDestinationChange: composer.setParticipantPickDestination,
        onFaabChange: composer.setParticipantFaab,
        onNotesChange: setNotes,
        onExpirationDaysChange: setExpirationDays,
    }

    if (!current) {
        return (
            <PageFrame style={styles.container}>
                <View style={styles.emptyCenter}><Text style={styles.emptyText}>No active league.</Text></View>
            </PageFrame>
        )
    }

    const verdict = (
        <TradeAnalysisSummary analysis={tradeAnalysis.analysis} participantName={composer.participantName}
            loading={tradeAnalysis.loading} inset={!sideBySide} />
    )

    // Review replaces the editor inside the same page, like any pushed screen,
    // instead of covering the whole window.
    if (reviewing) {
        return (
            <PageFrame style={styles.container}>
                <PageHeader
                    title="Review trade"
                    onBack={() => setReviewing(false)}
                    backLabel="Back to trade editor"
                    actions={(
                        <Pressable
                            onPress={handleSubmit}
                            style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                            disabled={!canSubmit}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !canSubmit }}
                            accessibilityLabel="Confirm and send trade"
                            testID="trade-confirm-submit"
                            id="trade-confirm-submit"
                        >
                            <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>Send</Text>
                        </Pressable>
                    )}
                />
                {/* Its own key, so review opens at the top instead of the editor's scroll position. */}
                <ScrollView key="review" style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                    <View style={styles.reviewColumn}>
                        {!online ? <Text style={styles.lockBannerText}>Connect to send this trade. Your draft stays here.</Text> : null}
                        <MultiTeamTradeBuilder {...multiTeamBuilderProps} reviewOnly />
                        <TradeAnalysisSummary analysis={tradeAnalysis.analysis} participantName={composer.participantName}
                            loading={tradeAnalysis.loading} />
                    </View>
                </ScrollView>
            </PageFrame>
        )
    }

    return (
        <PageFrame style={styles.container}>
            <PageHeader
                title={tradeComposerTitle(mode)}
                onBack={leave}
                backLabel="Cancel trade proposal"
                actions={(
                    <Pressable
                        onPress={() => setReviewing(true)}
                        style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                        disabled={!canSubmit}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canSubmit }}
                        accessibilityLabel="Review trade proposal"
                        testID="trade-submit"
                        id="trade-submit"
                    >
                        <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>
                            Review
                        </Text>
                    </Pressable>
                )}
            />
            <ScrollView key="editor" style={styles.scroll} contentContainerStyle={[styles.scrollContent, sideBySide && styles.scrollContentWide]} keyboardShouldPersistTaps="handled">
              <View style={[styles.main, sideBySide && styles.mainWide]}>
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
                <Text style={styles.sectionLabel}>Trade with</Text>
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
                {sideBySide ? null : verdict}
                <View style={styles.bottomSpace} />
              </View>
              {sideBySide ? <View style={styles.rail}>{verdict}</View> : null}
            </ScrollView>
        </PageFrame>
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
    scrollContent: { width: '100%', maxWidth: BUILDER_WIDTH, minWidth: 0, alignSelf: 'center' },
    scrollContentWide: {
        maxWidth: BUILDER_WIDTH + spacing['3xl'] + layout.railWidth,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing['3xl'],
    },
    main: { width: '100%', minWidth: 0 },
    reviewColumn: { width: '100%', maxWidth: BUILDER_WIDTH, alignSelf: 'center' },
    mainWide: { width: BUILDER_WIDTH, flexShrink: 0 },
    rail: { width: layout.railWidth, paddingTop: spacing.xl },
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
    submitText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    submitTextDisabled: { color: colors.textPlaceholder },
    sectionLabel: {
        ...textStyles.sectionLabel,
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
        paddingHorizontal: spacing.lg,
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
    bottomSpace: { height: spacing['5xl'] },
})
