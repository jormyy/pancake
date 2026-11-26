import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { useDraftActivity as useModalActivity } from '@/components/league/draft-room/useDraftActivity'
import { previewTradeLegality } from '@/lib/trade-legality'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { TradeLegalityScreen } from '@/components/trades/TradeLegalityScreen'
import { tradeDraft } from '@/lib/trade-draft'
import { isTradeRosterLegal } from '@/lib/trade-legality-step'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { uuid } from 'expo-modules-core'
import { SafeAreaView } from 'react-native-safe-area-context'

import { MAX_TRADE_ITEMS, MAX_TRADE_PARTICIPANTS } from '@pancake/core'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { TradePartnersCard } from '@/components/trades/TradePartnersCard'
import { TradeValueCard } from '@/components/trades/TradeValueCard'
import { TradeRouteOverview } from '@/components/trades/TradeCard'
import { colors, controlSize, fontWeight, layout, radii, spacing, typeScale } from '@/constants/tokens'
import { PageHeader, usePageMetrics } from '@/components/ui/Page'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import { useScrollAnchor } from '@/hooks/use-scroll-anchor'
import { isMultiTeamTradeSubmittable } from '@/lib/multi-team-trade-state'
import type { TradeComposerMember } from '@/lib/trade-ui-model'
import { confirmAction, showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage, RequestError } from '@/lib/shared/errors'
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import { rosterLimits } from '@/lib/roster-capacity'
import {
    buildTradeComposerPayload,
    buildTwoTeamTradeComposerPayload,
    getTradeComposerMode,
    prefillTradeComposerFromTrade,
    prefillTradeRosterPlan,
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
    type TradeRosterPlan,
    type TradeRosterPreview,
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

export default function ProposeTradeScreen() {
    const recoveryReady = useRef(false)
    useEffect(() => holdPwaUpdate('trade editor', () => recoveryReady.current), [])
    const { user } = useAuth()
    const { current, currentLeague, online } = useLeagueContext()
    const limits = rosterLimits(currentLeague)
    const { padX } = usePageMetrics()
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
    const [sourceMultiTeam, setSourceMultiTeam] = useState(false)
    const [notes, setNotes] = useState('')
    const [expirationDays, setExpirationDays] = useState('3')
    const [loading, setLoading] = useState(true)
    const [membersError, setMembersError] = useState<string | null>(null)
    const [rosterPlanDraft, setRosterPlan] = useState<TradeRosterPlan>({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] })
    const [fullRoster, setFullRoster] = useState<{ owner: string; rows: RosterPlayer[] } | null>(null)
    const [otherPlans, setOtherPlans] = useState<Record<string, TradeRosterPlan>>({})
    const [rosterPreviews, setRosterPreviews] = useState<TradeRosterPreview[]>([])
    const [legalityAttempt, setLegalityAttempt] = useState(0)
    const [legalityError, setLegalityError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [reviewing, setReviewing] = useState(false)
    const [valueDetailsOpen, setValueDetailsOpen] = useState(false)
    const builderAnchor = useScrollAnchor()
    const ownerIdentity = user?.id && myMemberId && leagueId ? `${user.id}:${leagueId}:${myMemberId}` : null
    const contextCacheKey = ownerIdentity ? `pancake:trade-editor-context:v1:${ownerIdentity}` : null
    const { canRead, capture, isCurrent, canAct, markReady, blockActions, epoch, ready } = useModalActivity(ownerIdentity)
    const [draftSeason, setDraftSeason] = useState<{ owner: string; id: string } | null>(null)
    const draftSeasonId = draftSeason?.owner === ownerIdentity ? draftSeason.id : null
    useEffect(() => {
        let disposed = false
        recoveryReady.current = false
        if (online && ownerIdentity && leagueId) void getCurrentSeasonId(leagueId).then(id => {
            if (!disposed && id) setDraftSeason({ owner: ownerIdentity, id })
        }).catch(() => {})
        return () => { disposed = true }
    }, [ownerIdentity, leagueId, online])
    const formOwnerRef = useRef(ownerIdentity)
    const writeEpoch = useRef(0)
    const tradePrefillKey = useRef<string | null>(null)
    const [membersAttempt, setMembersAttempt] = useState(0)
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
    const [prefillSettledKey, setPrefillSettledKey] = useState<string | null>(null)
    const { mode, editTradeId, counterTradeId, sourceTradeId } = getTradeComposerMode(params)
    const canEditPartners = mode === 'propose'
    const faabEnabled = currentLeague?.waiver_mode === 'faab'
    const composer = useMultiTeamTradeComposer({
        enabled: ready && Boolean(myMemberId && leagueId),
        myMemberId,
        leagueId,
        myTeamName: current?.team_name ?? 'Your team',
        members,
        faabEnabled,
        allowInactiveTrades: currentLeague?.allow_inactive_trades,
        recipientMemberId: selectedRecipientId ?? undefined,
    })
    const {
        loadedParticipantKey,
        buildMultiTeamItems,
        participantIds,
        participantViews,
        prefillFromTrade,
        prefillFromItems,
        selectParticipantAsset,
        setParticipantIds,
    } = composer
    const multiTeamMode = (!canEditPartners && sourceMultiTeam) || participantIds.length > 2
    const partnerIds = useMemo(() => multiTeamMode
        ? participantIds.filter((memberId) => memberId !== myMemberId)
        : selectedRecipientId ? [selectedRecipientId] : [], [multiTeamMode, myMemberId, participantIds, selectedRecipientId])

    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
    }, [])

    const ownsOwner = useCallback((capturedOwner: string | null) => (
        mountedRef.current && capturedOwner !== null && activeOwnerRef.current === capturedOwner
    ), [])

    useEffect(() => {
        if (formOwnerRef.current !== ownerIdentity) {
            formOwnerRef.current = ownerIdentity
            setNotes('')
            setExpirationDays('3')
            setRosterPlan({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] })
            setSourceMultiTeam(false)
            setValueDetailsOpen(false)
            setMembers([])
            setMembersError(null)
            restoredDraftRef.current = false
        }
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
        if (!canRead()) {
            if (!online && contextCacheKey && ownerIdentity) {
                const saved = readPersistentCache<{ members: TradeComposerMember[]; seasonId: string }>(contextCacheKey)
                setMembers(saved?.members ?? [])
                setMembersError(saved ? null : 'Offline. Open this trade editor online first.')
                if (saved) setDraftSeason({ owner: ownerIdentity, id: saved.seasonId })
                setLoading(false)
            }
            return
        }
        const generation = capture()
        blockActions()
        setLoading(true)
        setMembersError(null)
        try {
            const all = await getLeagueMembers(leagueId)
            if (membersRequestRef.current !== requestId || !isCurrent(generation)) return
            if (!all.some(member => member.id === myMemberId && member.user_id === user?.id)) {
                setMembersError('You no longer belong to this league.')
                return
            }
            markReady(generation)
            setMembers(all.filter((member) => member.id !== myMemberId))
        } catch (error) {
            if (membersRequestRef.current !== requestId || !isCurrent(generation)) return
            setMembersError(getErrorMessage(error) ?? 'Could not load league members.')
        } finally {
            if (membersRequestRef.current === requestId && isCurrent(generation)) setLoading(false)
        }
    }, [leagueId, myMemberId, user?.id, canRead, capture, isCurrent, blockActions, markReady, online, contextCacheKey, ownerIdentity])

    useEffect(() => {
        if (online && contextCacheKey && draftSeasonId && !loading && !membersError && formOwnerRef.current === ownerIdentity) {
            writePersistentCache(contextCacheKey, { members, seasonId: draftSeasonId })
        }
    }, [online, contextCacheKey, draftSeasonId, loading, membersError, members, ownerIdentity])

    useEffect(() => {
        void loadMembers()
        return () => { membersRequestRef.current += 1 }
    }, [loadMembers, epoch, membersAttempt])

    useEffect(() => {
        if (multiTeamMode || !selectedRecipientId || !myMemberId) return
        setParticipantIds([myMemberId, selectedRecipientId])
    }, [multiTeamMode, myMemberId, selectedRecipientId, setParticipantIds])

    useEffect(() => {
        if (!params.analyzerDraftId || analyzerDraftKeyRef.current === params.analyzerDraftId) return
        analyzerDraftKeyRef.current = params.analyzerDraftId
        const draft = takeTradeAnalyzerDraft(params.analyzerDraftId)
        if (!draft || draft.leagueId !== leagueId || draft.actorMemberId !== myMemberId) return
        setSelectedRecipientId(draft.participantMemberIds.length === 2
            ? draft.participantMemberIds.find((id) => id !== myMemberId) ?? null
            : null)
        prefillFromItems(draft.participantMemberIds, draft.items)
    }, [leagueId, myMemberId, params.analyzerDraftId, prefillFromItems])

    // A page reload (an app update reloads the page) brings back the trade this tab had not sent.
    useEffect(() => {
        if (!draftSeasonId) return
        if (draftOwnerRef.current !== null) {
            const sameOwner = draftOwnerRef.current === ownerIdentity
            if (!sameOwner) {
                clearTradeComposerDraft()
                draftOwnerRef.current = ownerIdentity
            }
            setDraftReady(Boolean(ownerIdentity))
            return
        }
        if (!ownerIdentity) return
        draftOwnerRef.current = ownerIdentity
        const draft = readTradeComposerDraft(ownerIdentity, mode, sourceTradeId, draftSeasonId)
        if (draft) {
            restoredDraftRef.current = true
            setSourceMultiTeam(draft.multiTeamMode)
            setSelectedRecipientId(draft.selectedRecipientId)
            setNotes(draft.notes)
            setExpirationDays(draft.expirationDays)
            setRosterPlan(draft.rosterPlan)
            setOtherPlans(draft.rosterPlans ?? {})
            prefillFromItems(draft.participantIds, draft.items)
            // The requested asset was already applied before the reload; the user may have removed it since.
            routePrefillKeyRef.current = `${draft.selectedRecipientId}:${params.requestPlayerId ?? ''}:${params.requestPickId ?? ''}`
        }
        setDraftReady(true)
    }, [mode, ownerIdentity, params.requestPickId, params.requestPlayerId, prefillFromItems, sourceTradeId, draftSeasonId])

    // Closing the editor ends the draft. A reload skips this cleanup, which is what keeps the draft.
    useEffect(() => clearTradeComposerDraft, [])

    useEffect(() => {
        if (!canRead() || tradePrefillKey.current === `${ownerIdentity}:${sourceTradeId}`) return
        const generation = capture()
        if (!sourceTradeId || !myMemberId) return
        const capturedOwner = ownerIdentity
        let cancelled = false
        getTradeById(sourceTradeId, myMemberId)
            .then((trade) => {
                if (!cancelled && isCurrent(generation)) setPrefillSettledKey(`${ownerIdentity}:${sourceTradeId}`)
                if (cancelled || !isCurrent(generation) || !ownsOwner(capturedOwner) || !trade || restoredDraftRef.current) return
                tradePrefillKey.current = `${ownerIdentity}:${sourceTradeId}`
                const prefill = prefillTradeComposerFromTrade(mode, trade)
                setSourceMultiTeam(trade.isMultiTeam)
                setSelectedRecipientId(trade.isMultiTeam ? null : prefill.selectedRecipientId)
                setNotes(prefill.notes)
                setExpirationDays(prefill.expirationDays)
                setRosterPlan(prefillTradeRosterPlan(trade, myMemberId))
                setOtherPlans(Object.fromEntries((trade.participants ?? []).filter(participant => participant.memberId !== myMemberId).map(participant => {
                    const incomingPlan = prefillTradeRosterPlan(trade, participant.memberId)
                    return [participant.memberId, { ...incomingPlan, dropPlayerIds: [], rosterMoves: [] }]
                })))
                prefillFromTrade(trade, myMemberId)
            })
            .catch((error) => {
                if (!cancelled && ownsOwner(capturedOwner) && isCurrent(generation)) {
                    setPrefillSettledKey(`${ownerIdentity}:${sourceTradeId}`)
                    showAlert('Error', getErrorMessage(error) ?? 'Could not load trade.')
                }
            })
        return () => {
            cancelled = true
        }
    }, [mode, myMemberId, ownerIdentity, ownsOwner, prefillFromTrade, sourceTradeId, canRead, capture, isCurrent, epoch])

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

    const addPartner = useCallback((memberId: string) => {
        if (!canEditPartners || memberId === myMemberId || partnerIds.includes(memberId) ||
            partnerIds.length + 1 >= MAX_TRADE_PARTICIPANTS) return
        if (partnerIds.length === 0) {
            setSelectedRecipientId(memberId)
            return
        }
        setSelectedRecipientId(null)
        setParticipantIds([myMemberId, ...partnerIds, memberId])
    }, [canEditPartners, myMemberId, partnerIds, setParticipantIds])

    const removePartner = useCallback((memberId: string) => {
        if (!canEditPartners) return
        const remaining = partnerIds.filter((partnerId) => partnerId !== memberId)
        setSelectedRecipientId(remaining.length === 1 ? remaining[0] : null)
        setParticipantIds([myMemberId, ...remaining])
    }, [canEditPartners, myMemberId, partnerIds, setParticipantIds])

    const items = useMemo(() => buildMultiTeamItems(), [buildMultiTeamItems])
    useEffect(() => {
        let cancelled = false
        if (!ownerIdentity || !leagueId || !myMemberId || !ready) return
        void getRoster(myMemberId, leagueId).then(rows => {
            if (!cancelled) setFullRoster({ owner: ownerIdentity, rows })
        }).catch(() => {})
        return () => { cancelled = true }
    }, [ownerIdentity, leagueId, myMemberId, ready])
    const ownPlanRoster = useMemo(() => [...new Map([
        ...(composer.participantRosters[myMemberId] ?? []),
        ...(fullRoster?.owner === ownerIdentity ? fullRoster.rows : []),
    ].map(row => [row.players.id, row])).values()], [composer.participantRosters, myMemberId, fullRoster, ownerIdentity])
    const rosterPlan = useMemo(() => {
        const incoming = new Set(items.flatMap(item => item.kind === 'player' && item.toMemberId === myMemberId ? [item.playerId] : []))
        const offered = new Set(items.flatMap(item => item.kind === 'player' ? [item.playerId] : []))
        const ownPlayers = new Set(ownPlanRoster.map(row => row.players.id))
        return {
            taxiPlayerIds: rosterPlanDraft.taxiPlayerIds.filter(id => incoming.has(id)),
            irPlayerIds: rosterPlanDraft.irPlayerIds.filter(id => incoming.has(id)),
            dropPlayerIds: rosterPlanDraft.dropPlayerIds.filter(id => ownPlayers.has(id) && !offered.has(id)),
            rosterMoves: rosterPlanDraft.rosterMoves?.filter(move => ownPlayers.has(move.playerId) && !offered.has(move.playerId)),
        }
    }, [items, myMemberId, ownPlanRoster, rosterPlanDraft])
    const rosterPlans = useMemo(() => ({ ...otherPlans, [myMemberId]: rosterPlan }), [otherPlans, myMemberId, rosterPlan])
    const legalityInput = JSON.stringify({ leagueId, memberIds: participantIds, items, plans: rosterPlans })
    useEffect(() => {
        let cancelled = false
        if (!leagueId || items.length === 0 || !composer.assetsReady) return
        setRosterPreviews([])
        const timer = setTimeout(() => {
            void previewTradeLegality(JSON.parse(legalityInput)).then(teams => {
                if (!cancelled) { setRosterPreviews(teams); setLegalityError(null) }
            }).catch(error => { if (!cancelled) setLegalityError(getErrorMessage(error)) })
        }, 200)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [legalityInput, leagueId, items.length, composer.assetsReady, legalityAttempt])
    const ownRosterPreview = rosterPreviews.find(team => team.memberId === myMemberId)
    // Leaving drops a built trade, so ask first once anything is selected.
    const leave = () => {
        if (items.length === 0) back()
        else confirmAction('Discard this trade?', 'The players and picks you picked will be cleared.', back, 'Discard')
    }
    const tradeAnalysis = useDynastyTradeAnalysis({
        debounceMs: 300,
        enabled: ready && composer.assetsReady,
        leagueId,
        memberId: myMemberId,
        scoringSettings: currentLeague?.scoring_settings,
        teams: Math.max(4, members.length + 1),
        faabBudget: currentLeague?.faab_starting_budget ?? 100,
        participants: composer.participantViews,
        items,
    })
    const [heldAnalysis, setHeldAnalysis] = useState(tradeAnalysis.analysis)
    if (tradeAnalysis.analysis && tradeAnalysis.analysis !== heldAnalysis) setHeldAnalysis(tradeAnalysis.analysis)
    const valueAnalysis = items.length === 0 ? null : tradeAnalysis.analysis ?? (tradeAnalysis.loading ? heldAnalysis : null)
    const valueUpdating = tradeAnalysis.loading && valueAnalysis !== null
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
    const intent = JSON.stringify({ ownerIdentity, seasonId: draftSeasonId, mode, sourceTradeId, multiTeamMode, selectedRecipientId,
        participantIds, items, notes, expirationDays, rosterPlan, rosterPlans: otherPlans })
    const retainedAttempt = retainedAttemptRef.current?.ownerIdentity === ownerIdentity &&
        retainedAttemptRef.current.intent === intent ? retainedAttemptRef.current : null
    useEffect(() => {
        if (retainedAttemptRef.current?.intent !== intent) retainedAttemptRef.current = null
    }, [intent])
    // Once Send starts, or a sent request's outcome is unknown, the server owns the trade: a restored
    // copy would send again under a new request key.
    const draftToKeep = draftReady && draftOwnerRef.current === ownerIdentity && !submitting && !retainedAttempt ? intent : null
    useEffect(() => {
        recoveryReady.current = false
        if (!draftReady) return
        if (!draftSeasonId || submitting || retainedAttempt) { clearTradeComposerDraft(); return }
        if (draftToKeep) recoveryReady.current = saveTradeComposerDraft(draftToKeep)
        else {
            clearTradeComposerDraft()
            recoveryReady.current = true
        }
    }, [draftReady, draftToKeep, draftSeasonId, submitting, retainedAttempt])
    const canSubmitNew = !tradingClosed && composer.selectedAssetsAvailable && withinItemLimit &&
        !notesError && !expirationError && (
        multiTeamMode
            ? isMultiTeamTradeSubmittable(participantIds, items)
            : Boolean(selectedRecipientId && twoTeamDraft?.hasOffer && twoTeamDraft.hasRequest && !twoTeamDraft.faabError)
    )
    const canSubmit = canAct() && online && !submitting && Boolean(retainedAttempt || canSubmitNew)

    const handleSubmit = useCallback(async () => {
        if (!canAct() || !ownerIdentity || !ownsOwner(ownerIdentity) || submissionRef.current || !canSubmit) return
        const submission = { ownerIdentity, token: Symbol('trade-submission') }
        submissionRef.current = submission
        setSubmitting(true)
        try {
            const generation = capture()
            const members = await getLeagueMembers(leagueId)
            if (!isCurrent(generation) || !ownsOwner(ownerIdentity)) return
            if (!members.some(member => member.id === myMemberId && member.user_id === user?.id)) {
                blockActions()
                setMembersError('You no longer belong to this league.')
                return
            }
            if (!retainedAttemptRef.current) {
                const teams = await previewTradeLegality(JSON.parse(legalityInput))
                if (!isCurrent(generation) || !ownsOwner(ownerIdentity)) return
                setRosterPreviews(teams)
                if (!isTradeRosterLegal(teams.find(team => team.memberId === myMemberId))) return
            }
            if (!isCurrent(generation) || !ownsOwner(ownerIdentity)) return
            writeEpoch.current = generation
            let attempt = retainedAttemptRef.current
            if (attempt?.ownerIdentity !== ownerIdentity || attempt.intent !== intent) attempt = null
            if (!attempt) {
                const requestId = uuid.v4()
                let seasonId: string | null = null
                const resolvedSeason = async () => {
                    if (!seasonId) seasonId = await getCurrentSeasonId(leagueId)
                    return seasonId
                }
                const guarded = <Args extends unknown[], Result>(write: (...args: Args) => Promise<Result>) => async (...args: Args) => {
                    if (!isCurrent(writeEpoch.current) || !canAct()) throw new Error('Return to this trade and try again.')
                    return write(...args)
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
                        rosterPlan,
                        rosterPlans,
                        estimateId: tradeAnalysis.quote?.id,
                        participantMemberIds: [...participantIds],
                        items: items.map((item) => ({ ...item })),
                        notes,
                        expirationDays,
                        leagueStatus: currentLeague?.status,
                        tradeDeadline: currentLeague?.trade_deadline,
                    }
                    send = () => submitMultiTeamTradeComposer(input,
                        { getCurrentSeasonId: resolvedSeason, proposeMultiTeamTrade: guarded(proposeMultiTeamTrade), counterMultiTeamTrade: guarded(counterMultiTeamTrade), editMultiTeamTrade: guarded(editMultiTeamTrade) })
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
                        payload: { ...payload, estimateId: tradeAnalysis.quote?.id, rosterPlan, rosterPlans, offerPlayerIds: [...payload.offerPlayerIds], requestPlayerIds: [...payload.requestPlayerIds],
                            offerPickIds: [...payload.offerPickIds], requestPickIds: [...payload.requestPickIds] },
                    }
                    send = () => submitTradeComposer(input,
                        { getCurrentSeasonId: resolvedSeason, proposeTrade: guarded(proposeTrade), counterTrade: guarded(counterTrade), editTrade: guarded(editTrade) })
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
                const rejected = error instanceof RequestError && (error.code === 'P0001' || error.code === 'PT001' || error.code === 'PA010' ||
                    (error.code === '22023' && error.message !== 'This request key already belongs to different trade terms.'))
                if (rejected) {
                    retainedAttemptRef.current = null
                    invalidateSeasonCache(leagueId)
                }
                setLegalityError(getErrorMessage(error) ?? 'Could not propose trade.')
            }
        } finally {
            if (submissionRef.current === submission) {
                submissionRef.current = null
                if (ownsOwner(ownerIdentity)) setSubmitting(false)
            }
        }
    }, [
        legalityInput, rosterPlans, capture, isCurrent, canAct, blockActions, user?.id,
        tradeAnalysis.quote?.id,
        rosterPlan,
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
        participants: composer.participantViews,
        items,
        myMemberId,
        faabEnabled,
        allowInactiveTrades: currentLeague?.allow_inactive_trades,
        notes,
        notesError,
        expirationDays,
        expirationError,
        leagueStatus: currentLeague?.status,
        tradeDeadline: currentLeague?.trade_deadline,
        rosterError: composer.rosterError,
        rosterLoading: !composer.displayReady && !composer.rosterError,
        avgMap: composer.avgMap,
        avgStatsMap: composer.avgStatsMap,
        participantName: composer.participantName,
        onRetry: composer.retry,
        onTogglePlayer: composer.toggleParticipantPlayer,
        onTogglePick: composer.toggleParticipantPick,
        onRemoveAsset: composer.removeParticipantAsset,
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

    const recipientReady = !selectedRecipientId || participantIds.includes(selectedRecipientId) ||
        (!loading && !members.some(member => member.id === selectedRecipientId))
    const prefillReady = !sourceTradeId || restoredDraftRef.current || prefillSettledKey === `${ownerIdentity}:${sourceTradeId}`
    const editorReady = Boolean(membersError || (draftReady && !loading && prefillReady && recipientReady &&
        (participantIds.length < 2 || composer.assetsLoaded || composer.rosterError)))
    const draft = tradeDraft({ items, participants: participantViews, memberId: myMemberId,
        participantName: composer.participantName, notes,
        expiresAt: buildTradeComposerPayload({ offerPlayerIds: [], requestPlayerIds: [], offerPickIds: [], requestPickIds: [],
            notes, offerFaabInput: '0', requestFaabInput: '0', expirationDaysInput: expirationDays,
            leagueStatus: currentLeague?.status, tradeDeadline: currentLeague?.trade_deadline }).payload.expiresAt ?? null,
        avgMap: composer.avgMap, avgStatsMap: composer.avgStatsMap })
    const valueCard = (details: boolean) => (
        <TradeValueCard
            analysis={valueAnalysis}
            loading={tradeAnalysis.loading && !valueUpdating}
            updating={valueUpdating}
            error={tradeAnalysis.error}
            empty={items.length === 0}
            myMemberId={myMemberId}
            participantIds={participantIds}
            participantName={composer.participantName}
            detailsOpen={details && valueDetailsOpen}
            onToggleDetails={details ? () => setValueDetailsOpen(open => !open) : undefined}
            onRetry={tradeAnalysis.retry}
        />
    )
    if (reviewing) {
        return <PageFrame style={styles.container}>
            <TradeLegalityScreen trade={draft} memberId={myMemberId} teams={rosterPreviews}
                loading={!canSubmit || rosterPreviews.length === 0} saving={submitting} error={legalityError}
                onRetry={() => setLegalityAttempt(value => value + 1)} onClose={() => setReviewing(false)} onSubmit={handleSubmit} mode="propose" retrying={Boolean(retainedAttempt)}
                value={valueCard(false)}
                editor={{ incoming: draft.routedItems.filter(item => item.toMemberId === myMemberId),
                    roster: ownPlanRoster.filter(row => !items.some(item => item.kind === 'player' && item.playerId === row.players.id)),
                    value: rosterPlan, onChange: setRosterPlan, avgMap: composer.avgMap, avgStatsMap: composer.avgStatsMap,
                    unavailableMoves: ownRosterPreview?.unavailableMoves, unavailableDestinations: ownRosterPreview?.unavailableDestinations,
                    allowIR: limits ? limits.irSlots > 0 : false, allowTaxi: limits ? limits.taxiSlots > 0 : false }} />
        </PageFrame>
    }

    return (
        <PageFrame style={styles.container}>
            <PageHeader
                title={tradeComposerTitle(mode)}
                showTitle
                onBack={leave}
                backLabel="Cancel trade proposal"
                actions={(
                    <HeaderAction title="Review" disabled={!canSubmit} onPress={() => setReviewing(true)}
                        accessibilityLabel="Review trade proposal" targetId="trade-submit" />
                )}
            />
            <DeferredContent ready={editorReady} key={ownerIdentity} style={styles.scrollRegion}>
            <ScrollView key="editor" ref={builderAnchor.scrollRef} {...builderAnchor.scrollProps} style={styles.scroll} contentContainerStyle={[styles.scrollContent, { paddingHorizontal: padX }]} keyboardShouldPersistTaps="handled">
                <View ref={builderAnchor.leadRef} style={styles.lead}>
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
                    {membersError ? (
                        <>
                            <ErrorBanner message={membersError} onRetry={() => setMembersAttempt(value => value + 1)} />
                            <EmptyState icon="error-outline" message="Teams unavailable"
                                description="Retry to load the league members available for this trade."
                                fullScreen={false} framed />
                        </>
                    ) : (
                        <>
                            {draft.routedItems.length > 0 ? <TradeRouteOverview trade={draft} myMemberId={myMemberId} /> : null}
                            {valueCard(true)}
                            {valueDetailsOpen && items.length > 0 ? (
                                <TradeAnalysisSummary players={Object.values(composer.participantRosters).flat()} analysis={valueAnalysis}
                                    calculatedAt={tradeAnalysis.quote?.createdAt} participantName={composer.participantName}
                                    loading={tradeAnalysis.loading && !valueUpdating} inset={false} />
                            ) : null}
                            <TradePartnersCard
                                partnerIds={partnerIds}
                                members={members}
                                editable={canEditPartners}
                                canAdd={participantIds.length < MAX_TRADE_PARTICIPANTS && partnerIds.length + 1 < MAX_TRADE_PARTICIPANTS}
                                loading={loading}
                                teamName={composer.participantName}
                                onAdd={addPartner}
                                onRemove={removePartner}
                            />
                        </>
                    )}
                </View>
                {!membersError && composer.participantViews.length >= 2 ? (
                    <MultiTeamTradeBuilder {...multiTeamBuilderProps} />
                ) : null}
            </ScrollView>
            </DeferredContent>
        </PageFrame>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

function HeaderAction({ title, onPress, disabled = false, accessibilityLabel, targetId }: { title: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string; targetId?: string }) {
    return (
        <Pressable
            onPress={onPress}
            style={[styles.submitButton, disabled && styles.submitButtonDisabled]}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            accessibilityLabel={accessibilityLabel ?? title}
            testID={targetId}
            id={targetId}
        >
            <Text style={[styles.submitText, disabled && styles.submitTextDisabled]} numberOfLines={1}>{title}</Text>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },
    scrollRegion: { flex: 1, minHeight: 0 },
    lead: { width: '100%', minWidth: 0, gap: spacing.md },
    scrollContent: {
        width: '100%',
        maxWidth: layout.contentMaxWidth,
        minWidth: 0,
        alignSelf: 'center',
        gap: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing['5xl'],
    },
    submitButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        minHeight: controlSize.minTouch,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: controlSize.minTouch + spacing['3xl'],
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButtonDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight, opacity: 0.55 },
    submitText: { ...typeScale.row, color: colors.textWhite, fontWeight: fontWeight.bold },
    submitTextDisabled: { color: colors.textPlaceholder },
    lockBanner: {
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.warningDark,
        backgroundColor: colors.warningLight,
    },
    lockBannerText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.warningDark, textAlign: 'center' },
    emptyCenter: { alignItems: 'center', padding: spacing['5xl'] },
    emptyText: { ...typeScale.body, color: colors.textPlaceholder, textAlign: 'center' },
})
