import { cachedScreenView, readScreenView, subscribeScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import type { ClaimEditorView } from '@/lib/cache/view-types'
import { clearEditorDraft, readEditorDraft, saveEditorDraft } from '@/lib/editor-draft'
import { isClaimDraft } from '@/lib/claim-draft'

import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { isTaxiEligible } from '@pancake/core'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { getLeagueMembers } from '@/lib/league'
import { useDraftActivity as useModalActivity } from '@/components/league/draft-room/useDraftActivity'
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    Switch,
    ScrollView,
    Platform,
    useWindowDimensions,
    type ViewStyle,
} from 'react-native'
import { ScreenFrame } from '@/components/ui/ScreenFrame'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useLocalSearchParams } from 'expo-router'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useAuth } from '@/hooks/use-auth'
import { RosterPlayer } from '@/lib/roster'
import { getPlayer } from '@/lib/players'
import { claimProcessDateLabel, claimProcessTimeLabel, submitWaiverClaim, editWaiverClaim, scheduledClaimLabel } from '@/lib/waivers'
import { type MemberTransactionState } from '@/lib/league'

import { addLimitSummary, canAddToIR, reportPickupError } from '@/lib/pickup'
import { blockedActionProps } from '@/lib/a11y'
import { useAddLimitGate } from '@/hooks/use-add-limit-gate'
import { colors, controlSize, fontFamily, fontSize, fontWeight, layout, radii, spacing, table, textStyles, uiColors } from '@/constants/tokens'
import { LoadingState, PageHeader, usePageMetrics } from '@/components/ui'
import { showAlert, showSuccess } from '@/lib/alert'

import { EmptyState } from '@/components/EmptyState'
import { useGoBack } from '@/components/ui/useGoBack'

const IRResolutionModal = lazy(() => import('@/components/IRResolutionModal').then(module => ({ default: module.IRResolutionModal })))

type ClaimSnapshot = { taxiExitIds?: string[]; player: Awaited<ReturnType<typeof getPlayer>>; roster: RosterPlayer[]; priority: number | null; clearsAt: string | null; transactionState: MemberTransactionState | null }

export default function ClaimPlayerScreen() {
    const recoveryReady = useRef(false)
    useEffect(() => holdPwaUpdate('claim editor', () => recoveryReady.current), [])
    const { playerId, claimId } = useLocalSearchParams<{ playerId: string; claimId?: string }>()
    const { current, currentLeague } = useLeagueContext()
    const { user } = useAuth()
    const online = useOnlineStatus()
    const goBack = useGoBack('/players')

    const rosterSize = currentLeague?.roster_size ?? 20
    const leagueId = currentLeague?.id
    const memberId = current?.id
    const userId = user?.id
    const ownerKey = JSON.stringify([userId, memberId, leagueId, playerId, claimId])
    const cacheKey = `pancake:claim-player:v1:${ownerKey}`
    const [draftOwner, setDraftOwner] = useState<{ key: string; scope: string } | null>(null)
    const draftOwnerRef = useRef(draftOwner)
    draftOwnerRef.current = draftOwner
    const initializedForm = useRef<string | null>(null)
    const submittedForm = useRef<string | null>(null)
    if (draftOwner?.key !== ownerKey) recoveryReady.current = false
    useEffect(() => () => {
        if (draftOwnerRef.current) clearEditorDraft('claim', draftOwnerRef.current.scope)
    }, [])
    const savedView = userId && memberId && leagueId && playerId ? cachedScreenView<ClaimEditorView>(screenScope('claim-editor', leagueId, memberId, { playerId, claimId }, userId))?.value : undefined
    const [initialCache] = useState<ClaimSnapshot | null>(() => savedView ? { player: savedView.player, roster: savedView.roster, priority: savedView.priority, clearsAt: savedView.clearsAt, transactionState: savedView.transactionState, taxiExitIds: savedView.taxiExitIds } : readPersistentCache<ClaimSnapshot>(cacheKey))
    const [loadError, setLoadError] = useState<string | null>(null)
    const [player, setPlayer] = useState<ClaimSnapshot['player'] | null>(initialCache?.player ?? null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>(initialCache?.roster ?? [])
    const [priority, setPriority] = useState<number | null>(initialCache?.priority ?? null)
    const [clearsAt, setClearsAt] = useState<string | null>(initialCache?.clearsAt ?? null)
    const [transactionState, setTransactionState] = useState<MemberTransactionState | null>(initialCache?.transactionState ?? null)
    const [taxiExitIds, setTaxiExitIds] = useState(new Set(initialCache?.taxiExitIds ?? []))
    const [taxiChoice, setTaxiChoice] = useState<{ owner: string; value: boolean } | null>(null)
    const [irChoice, setIRChoice] = useState<{ owner: string; value: boolean } | null>(null)
    const [bidInput, setBidInput] = useState('0')
    const [savedProcessDate, setSavedProcessDate] = useState<string | null>(null)
    const [loading, setLoading] = useState(!initialCache)
    const [selectedDrop, setSelectedDrop] = useState<RosterPlayer | null>(null)
    useEffect(() => {
        if (draftOwner?.key !== ownerKey || submittedForm.current === ownerKey) return
        recoveryReady.current = saveEditorDraft('claim', draftOwner.scope, {
            bid: bidInput, dropPlayerId: selectedDrop?.players.id ?? null,
            toIr: irChoice?.owner === ownerKey ? irChoice.value : null,
            toTaxi: taxiChoice?.owner === ownerKey ? taxiChoice.value : null,
        })
    }, [draftOwner, ownerKey, bidInput, selectedDrop, irChoice, taxiChoice])
    const [submittingOwner, setSubmittingOwner] = useState<{ key: string } | null>(null)
    const claimLoadSeqRef = useRef(0)
    const submittingRef = useRef<{ key: string } | null>(null)
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState({ width, height })
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])
    const viewportWidth = Platform.OS === 'web' ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' ? webViewport.height : height
    const isCompactLandscape = viewportWidth > viewportHeight && viewportHeight < 520
    const { padX, usableWidth } = usePageMetrics()

    const { canRead, capture, isCurrent, canAct, markReady, blockActions, epoch } = useModalActivity(userId && memberId && leagueId && playerId ? ownerKey : null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const ownerRef = useRef({ key: ownerKey })
    if (ownerRef.current.key !== ownerKey) ownerRef.current = { key: ownerKey }
    const submitting = submittingOwner === ownerRef.current
    useEffect(() => () => { ownerRef.current = { key: ownerRef.current.key } }, [])

    useEffect(() => {
        const cached = readPersistentCache<ClaimSnapshot>(cacheKey)
        setLoading(!cached)
        setLoadError(null)
        setPlayer(cached?.player ?? null)
        setMyRoster(cached?.roster ?? [])
        setTaxiExitIds(new Set(cached?.taxiExitIds ?? []))
        setPriority(cached?.priority ?? null)
        setTransactionState(cached?.transactionState ?? null)
        setClearsAt(cached?.clearsAt ?? null)
        setSelectedDrop(null)
        setBidInput('0')
    }, [ownerKey, cacheKey])

    useEffect(() => {
        if (!canRead()) return
        const requestId = ++claimLoadSeqRef.current
        const owner = ownerRef.current
        const generation = capture()
        setLoading(true)
        setLoadError(null)
        blockActions()
        async function load() {
            if (!memberId || !userId || !playerId || !leagueId) {
                if (claimLoadSeqRef.current === requestId && ownerRef.current === owner && isCurrent(generation)) setLoading(false)
                return
            }
            const requestedPlayerId = playerId
            const requestedLeagueId = leagueId
            try {
                const view = await readScreenView<ClaimEditorView>(screenScope('claim-editor', requestedLeagueId, memberId, { playerId: requestedPlayerId, claimId }, userId), { force: loadAttempt > 0 })
                const { player: p, roster, priority: prio, transactionState: txState, clearsAt: waiverEnds, members, claims } = view
                const exits = new Set(view.taxiExitIds)
                const seasonId = view.context.seasonId
                if (claimLoadSeqRef.current !== requestId || ownerRef.current !== owner || !isCurrent(generation)) return
                if (!members.some(member => member.id === memberId && member.user_id === userId)) {
                    setLoadError('You no longer belong to this league.')
                    return
                }
                writePersistentCache<ClaimSnapshot>(cacheKey, { player: p, roster, priority: prio, clearsAt: waiverEnds, transactionState: txState, taxiExitIds: [...exits] })
                setPlayer(p)
                setClearsAt(waiverEnds)
                setMyRoster(roster)
                setTaxiExitIds(exits)
                setPriority(prio)
                setTransactionState(txState)
                setSelectedDrop(previous => previous ? roster.find(row => row.id === previous.id) ?? null : null)
                const claim = claimId ? claims.find(item => item.id === claimId && item.playerId === playerId && item.status === 'pending') : null
                if (claimId && !claim) throw new Error('This pending claim is no longer available.')
                if (!seasonId) throw new Error('No active season is available.')
                setSavedProcessDate(claim?.processDate ?? null)
                const scope = JSON.stringify([userId, requestedLeagueId, seasonId, memberId, playerId, claimId ?? null])
                if (initializedForm.current !== scope) {
                    initializedForm.current = scope
                    const draft = readEditorDraft('claim', scope, isClaimDraft)
                    setBidInput(draft?.bid ?? String(claim?.bidAmount ?? 0))
                    setSelectedDrop(roster.find(row => row.players.id === (draft ? draft.dropPlayerId : claim?.dropPlayerId)) ?? null)
                    const toIr = draft ? draft.toIr : claim ? Boolean(claim.toIr) : null
                    const toTaxi = draft ? draft.toTaxi : claim ? Boolean(claim.toTaxi) : null
                    setIRChoice(toIr === null ? null : { owner: ownerKey, value: toIr })
                    setTaxiChoice(toTaxi === null ? null : { owner: ownerKey, value: toTaxi })
                    setDraftOwner({ key: ownerKey, scope })
                }
                markReady(generation)
            } catch (e) {
                if (claimLoadSeqRef.current !== requestId || ownerRef.current !== owner || !isCurrent(generation)) return
                console.error(e)
                setLoadError('Could not refresh the waiver claim. Try again.')
            } finally {
                if (claimLoadSeqRef.current === requestId && ownerRef.current === owner && isCurrent(generation)) setLoading(false)
            }
        }
        void load()
        return () => { claimLoadSeqRef.current += 1 }
    }, [leagueId, memberId, playerId, claimId, ownerKey, userId, canRead, capture, isCurrent, markReady, blockActions, epoch, loadAttempt, cacheKey, currentLeague?.taxi_slots])

    useEffect(() => {
        if (!userId || !memberId || !leagueId || !playerId) return
        const scope = screenScope('claim-editor', leagueId, memberId, { playerId, claimId }, userId)
        return subscribeScreenView(scope, () => { if (cachedScreenView(scope)?.dirty) setLoadAttempt(value => value + 1) })
    }, [userId, memberId, leagueId, playerId, claimId])

    const refreshTransactionState = useCallback(() => {
        blockActions()
        setLoadAttempt(value => value + 1)
    }, [blockActions])

    const activeRoster = myRoster.filter((p) => !p.is_on_ir && !p.is_on_taxi)
    const rosterFull = activeRoster.length >= rosterSize
    const irEligible = player?.injury_status != null
        && canAddToIR(player.injury_status, myRoster, currentLeague?.ir_slots ?? 2)
    const taxiEligible = (currentLeague?.taxi_slots ?? 0) > myRoster.filter(row => row.is_on_taxi).length
        && isTaxiEligible(player?.years_exp ?? null, player?.career_regular_season_games ?? null) && !taxiExitIds.has(playerId)
    const toIr = irEligible && (irChoice?.owner === ownerKey ? irChoice.value : true)
    const toTaxi = !toIr && taxiEligible && (taxiChoice?.owner === ownerKey ? taxiChoice.value : rosterFull)
    const needsDrop = rosterFull && !toIr && !toTaxi
    const rosterLegality = useRosterLegality({ memberId, leagueId, rosterSize, irSlots: currentLeague?.ir_slots ?? 2, onChanged: refreshTransactionState })
    const faab = currentLeague?.waiver_mode === 'faab'
    const balanceUnknown = faab && transactionState == null
    const { addBlockedReason, explainBlock } = useAddLimitGate({ transactionState, refresh: refreshTransactionState })

    async function handleSubmit() {
        if ((!online || !canAct()) || submittingRef.current === ownerRef.current) return
        if (!current || !user || !playerId || !currentLeague) return
        if (loading || !player) return
        if (balanceUnknown) return
        if (explainBlock()) return
        if (online && !await rosterLegality.check(myRoster)) return
        if (needsDrop && !selectedDrop) {
            showAlert('Select Drop', 'Your roster is full. Select a player to drop.')
            return
        }
        const bidAmount = Math.max(0, parseInt(bidInput || '0', 10) || 0)
        if (faab && transactionState && bidAmount > transactionState.faabBalance) {
            showAlert('Invalid Bid', 'Your bid cannot exceed your available FAAB balance.')
            return
        }

        const owner = ownerRef.current
        const generation = capture()
        submittingRef.current = owner
        setSubmittingOwner(owner)
        try {
            const members = online ? await getLeagueMembers(currentLeague.id) : [{ id: current.id, user_id: user.id }]
            if ((online && !isCurrent(generation)) || ownerRef.current !== owner) return
            if (!members.some(member => member.id === current.id && member.user_id === user.id)) {
                blockActions()
                showAlert('Access changed', 'You no longer belong to this league.')
                return
            }
            if (claimId) {
                await editWaiverClaim(claimId, current.id, {
                    dropPlayerId: selectedDrop?.players.id ?? null,
                    bidAmount, toIr, toTaxi,
                })
            } else {
                await submitWaiverClaim(current.id, currentLeague.id, playerId, selectedDrop?.players.id, { bidAmount, ...(irEligible ? { toIr } : {}), ...(taxiEligible ? { toTaxi } : {}) })
            }
            if (ownerRef.current !== owner) return
            submittedForm.current = ownerKey
            recoveryReady.current = false
            if (draftOwnerRef.current) clearEditorDraft('claim', draftOwnerRef.current.scope)
            showSuccess(
                claimId ? 'Claim Updated' : 'Claim Submitted',
                `Your claim processes ${savedProcessDate ? scheduledClaimLabel(savedProcessDate) : claimProcessTimeLabel(clearsAt)}.`,
            )
            goBack()
        } catch (e) {
            if (ownerRef.current === owner && !await rosterLegality.report(e)) reportPickupError(e, { refresh: refreshTransactionState })
        } finally {
            if (submittingRef.current === owner) submittingRef.current = null
            if (ownerRef.current === owner) setSubmittingOwner(null)
        }
    }

    const processDateStr = savedProcessDate ? scheduledClaimLabel(savedProcessDate) : claimProcessDateLabel(clearsAt)
    const claimReady = online && canAct() && !loading && !!player
    const submitDisabled = submitting || !claimReady || balanceUnknown || (needsDrop && !selectedDrop)
    const compactDropMode = isCompactLandscape && needsDrop
    // Wide screens put the claim beside the drop list instead of stacking them.
    const twoColumn = needsDrop && !isCompactLandscape && usableWidth >= TWO_COLUMN_MIN
    const claimFacts = [
        `Processes ${processDateStr}`,
        transactionState ? `Adds ${transactionState.weeklyAddCount}/${transactionState.weeklyAddLimit ?? '∞'}` : null,
        `${faab ? 'Tiebreak' : 'Priority'} #${priority ?? '—'}`,
    ].filter(Boolean).join(' · ')

    function setBid(value: string) {
        if (/^\d*$/.test(value)) setBidInput(value)
    }

    function renderAddLimitNotice() {
        if (!addBlockedReason) return null
        return (
            <View
                style={styles.limitCard}
                accessibilityLiveRegion="polite"
                role="status"
                testID="add-limit-notice"
            >
                <Text style={styles.limitBody}>{addBlockedReason}</Text>
                <Text style={styles.limitMeta}>{addLimitSummary(transactionState)}</Text>
            </View>
        )
    }

    // Sits at the top right like every other page's main action. A blocked
    // add stays pressable so the tap can explain why.
    function renderSubmitButton() {
        return (
            <Pressable
                style={[styles.submitButton, (submitDisabled || addBlockedReason != null) && styles.submitButtonDisabled]}
                onPress={handleSubmit}
                accessibilityRole="button"
                accessibilityLabel={claimId ? "Save waiver claim" : "Submit waiver claim"}
                {...blockedActionProps(addBlockedReason, submitDisabled)}
                disabled={submitDisabled}
            >
                {/* Narrow phones drop "Claim" so the page title still fits beside it. */}
                <Text style={styles.submitButtonText}>{claimId ? 'Save Claim' : usableWidth < NARROW_HEADER ? 'Submit' : 'Submit Claim'}</Text>
            </Pressable>
        )
    }

    function renderScreenHeader() {
        return (
            <PageHeader
                title="Waiver Claim"
                onBack={goBack}
                backLabel="Back"
                actions={renderSubmitButton()}
            />
        )
    }

    function renderIRChoice() {
        return <>
        {irEligible ? (
            <View style={styles.irChoice}>
                <View style={styles.claimPlayerCopy}>
                    <Text style={styles.bidLabel}>Place on IR</Text>
                    <Text style={styles.claimMeta}>Needs active roster space if IR becomes unavailable.</Text>
                </View>
                <Switch value={toIr} onValueChange={value => { setIRChoice({ owner: ownerKey, value }); if (value) setTaxiChoice({ owner: ownerKey, value: false }) }}
                    accessibilityLabel="Place on IR" disabled={submitting} />
            </View>
        ) : null}
        {taxiEligible ? <View style={styles.irChoice}>
            <View style={styles.claimPlayerCopy}>
                <Text style={styles.bidLabel}>Place on taxi</Text>
                <Text style={styles.claimMeta}>Needs active roster space if taxi becomes unavailable.</Text>
            </View>
            <Switch value={toTaxi} onValueChange={value => { setTaxiChoice({ owner: ownerKey, value }); if (value) setIRChoice({ owner: ownerKey, value: false }) }} accessibilityLabel="Place on taxi" disabled={submitting} />
        </View> : null}
        </>
    }

    function renderClaimSummary() {
        return (
            <View style={styles.claimCard}>
                <View style={styles.claimPlayerRow}>
                    <PlayerRowContent name={player?.display_name ?? '—'} nbaId={player?.nba_id} team={player?.nba_team}
                        positions={player?.eligible_positions?.length ? player.eligible_positions : player?.position ? [player.position] : []}
                        yearsExp={player?.years_exp} careerGames={player?.career_regular_season_games} injuryStatus={player?.injury_status} />
                </View>
                <Text style={styles.claimFacts}>{claimFacts}</Text>
                {renderIRChoice()}
                {faab ? (
                    <View style={styles.bidRow}>
                        <Text style={styles.bidLabel}>FAAB bid</Text>
                        <View style={styles.bidField}>
                            <Text style={styles.bidCurrency}>$</Text>
                            <TextInput
                                style={styles.bidInput}
                                value={bidInput}
                                onChangeText={setBid}
                                keyboardType="numeric"
                                selectTextOnFocus
                                accessibilityLabel="FAAB bid amount"
                            />
                        </View>
                        <Text style={styles.bidBalance}>{transactionState ? `of $${transactionState.faabBalance}` : 'Balance unavailable'}</Text>
                    </View>
                ) : null}
            </View>
        )
    }

    function renderDropSection() {
        if (!needsDrop) {
            return (
                <View style={styles.spaceNote}>
                    <Text style={styles.spaceNoteText}>{toIr ? 'Place on IR. No drop required.' : toTaxi ? 'Place on taxi. No drop required.' : 'You have roster space. No drop required.'}</Text>
                </View>
            )
        }
        return (
            <View style={styles.dropSection}>
                <View style={styles.dropHeading}>
                    {/* Literal casing: browser checks read this label verbatim. */}
                    <Text style={styles.sectionTitle}>
                        {compactDropMode ? 'DROP A PLAYER FOR CLAIM' : 'DROP A PLAYER (required)'}
                    </Text>
                                    </View>
                <View style={styles.rosterList}>{renderRosterDropRows()}</View>
            </View>
        )
    }

    function renderRosterDropRows() {
        return activeRoster.map((item, index) => {
            const isSelected = selectedDrop?.id === item.id
            return (
                <Pressable
                    key={item.id}
                    style={[styles.rosterRow, index > 0 && styles.rosterRowDivider, isSelected && styles.rosterRowSelected]}
                    onPress={() => setSelectedDrop(isSelected ? null : item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${item.players.display_name} to drop`}
                    accessibilityState={{ selected: isSelected }}
                >
                    <PlayerRowContent name={item.players.display_name} nbaId={item.players.nba_id} team={item.players.nba_team}
                        positions={item.players.eligible_positions?.length ? item.players.eligible_positions : item.players.position ? [item.players.position] : []}
                        yearsExp={item.players.years_exp} careerGames={item.players.career_regular_season_games} injuryStatus={item.players.injury_status} />
                    <View style={[styles.check, isSelected && styles.checkSelected]}>
                        {isSelected && <MaterialIcons name="check" size={16} color={colors.onAccent} />}
                    </View>
                </Pressable>
            )
        })
    }

    // Short landscape screens hide the claim card, so the bid moves to a footer.
    const bidFooter = faab && compactDropMode ? (
        <View style={[styles.footer, { paddingHorizontal: padX }]}>
            <View style={[styles.footerInner, styles.footerBidControl]}>
                <Text style={styles.footerBidLabel}>FAAB</Text>
                <TextInput
                    style={styles.footerBidInput}
                    value={bidInput}
                    onChangeText={setBid}
                    keyboardType="numeric"
                    selectTextOnFocus
                    accessibilityLabel="FAAB bid amount"
                />
            </View>
        </View>
    ) : null

    return (
        <>
            <Stack.Screen options={{ title: 'Waiver Claim', presentation: 'modal', headerShown: false }} />
            <ScreenFrame style={styles.container} edges={['bottom']}>
                <View style={{ flex: 1 }} aria-busy={loading} accessibilityState={{ busy: loading }}>
                {renderScreenHeader()}
                {loadError ? (
                    <Pressable onPress={() => setLoadAttempt(value => value + 1)} accessibilityRole="button" accessibilityLabel="Retry waiver claim load" style={{ padding: spacing.lg }}>
                        <Text accessibilityRole="alert" style={{ color: colors.danger }}>{loadError} Tap to retry.</Text>
                    </Pressable>
                ) : null}
                {balanceUnknown && !loading ? (
                    <Pressable onPress={refreshTransactionState} accessibilityRole="button" accessibilityLabel="Retry FAAB balance" style={{ padding: spacing.lg }}>
                        <Text accessibilityRole="alert" style={{ color: colors.danger }}>Could not load your FAAB balance. Tap to retry.</Text>
                    </Pressable>
                ) : null}
                {/* Until the claim loads, its facts (date, drop rule) would be guesses. */}
                {loading && !player ? <LoadingState /> : !player ? (
                    <EmptyState
                        icon="person-off"
                        message="Couldn't load this player"
                        description="Check your connection, then try again."
                        actionLabel="Try Again"
                        onAction={() => setLoadAttempt(value => value + 1)}
                    />
                ) : twoColumn ? (
                    <ScrollView
                        style={styles.bodyScroll}
                        contentContainerStyle={[styles.bodyContent, styles.bodyContentWide, { paddingHorizontal: padX }]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={styles.columns}>
                            <View style={styles.sideColumn}>
                                {renderAddLimitNotice()}
                                {renderClaimSummary()}
                            </View>
                            <View style={styles.mainColumn}>{renderDropSection()}</View>
                        </View>
                    </ScrollView>
                ) : (
                    <>
                        <ScrollView
                            style={styles.bodyScroll}
                            contentContainerStyle={[styles.bodyContent, { paddingHorizontal: padX }]}
                            keyboardShouldPersistTaps="handled"
                        >
                            {renderAddLimitNotice()}
                            {!compactDropMode ? renderClaimSummary() : renderIRChoice()}
                            {renderDropSection()}
                        </ScrollView>
                        {bidFooter}
                    </>
                )}
                </View>
            </ScreenFrame>
            {rosterLegality.modalProps.visible ? <Suspense fallback={null}><IRResolutionModal {...rosterLegality.modalProps} /></Suspense> : null}
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const TWO_COLUMN_MIN = 900
const NARROW_HEADER = 360

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    bodyScroll: { flex: 1 },
    bodyContent: {
        width: '100%',
        maxWidth: layout.formMaxWidth,
        alignSelf: 'center',
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
        gap: spacing.md,
    },
    bodyContentWide: { maxWidth: layout.contentMaxWidth },
    columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    // Sticky on web so the claim stays in view while the drop list scrolls.
    sideColumn: {
        width: 380,
        flexShrink: 0,
        gap: spacing.lg,
        ...(Platform.OS === 'web' ? ({ position: 'sticky', top: spacing.lg } as unknown as ViewStyle) : null),
    },
    mainColumn: { flex: 1, minWidth: 0 },

    limitCard: {
        padding: spacing.lg,
        backgroundColor: uiColors.brandSurfaceSoft,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        gap: spacing.xs,
    },
    limitBody: { ...textStyles.body },
    limitMeta: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: uiColors.brandText },

    claimCard: {
        padding: spacing.lg,
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        gap: spacing.md,
    },
    claimPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    claimPlayerCopy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    claimName: { ...textStyles.rowTitle },
    claimMeta: { ...textStyles.meta },
    claimFacts: { ...textStyles.meta, color: colors.textSecondary },
    irChoice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    bidRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    bidLabel: { ...textStyles.rowTitle, flex: 1 },
    bidField: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: controlSize.field.md,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgInput,
    },
    bidCurrency: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textMuted },
    // 16px keeps iOS Safari from zooming into the field.
    bidInput: { width: 64, minHeight: controlSize.field.md, fontSize: controlSize.field.fontSize, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'right' },
    bidBalance: { ...textStyles.meta },

    dropSection: { gap: spacing.md },
    dropHeading: { gap: spacing.xs },
    sectionTitle: { ...textStyles.sectionLabel, textTransform: 'none' as const },
    rosterList: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
    },
    rosterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: table.rowHeight,
        paddingHorizontal: spacing.lg,
    },
    rosterRowDivider: { borderTopWidth: 1, borderTopColor: colors.separator },
    rosterRowSelected: { backgroundColor: uiColors.dangerSurface },
    rosterInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    rosterName: { ...textStyles.rowTitle },
    rosterMeta: { ...textStyles.meta },
    check: {
        width: 24,
        height: 24,
        borderRadius: radii.full,
        borderWidth: 1.5,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkSelected: { backgroundColor: colors.danger, borderColor: colors.danger },

    spaceNote: {
        padding: spacing.lg,
        backgroundColor: uiColors.successSurface,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.successBorder,
    },
    spaceNoteText: { fontSize: fontSize.md, color: uiColors.successText, fontWeight: fontWeight.semibold, textAlign: 'center' },

    footer: {
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        backgroundColor: colors.bgScreen,
    },
    footerInner: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center' },
    footerBidControl: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: controlSize.field.md,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgInput,
    },
    footerBidLabel: { ...textStyles.sectionLabel },
    footerBidInput: { width: 56, minHeight: controlSize.field.md, fontSize: controlSize.field.fontSize, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'center' },
    submitButton: {
        minHeight: controlSize.button.sm.height,
        paddingHorizontal: controlSize.button.sm.padX,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButtonDisabled: { opacity: 0.55 },
    submitButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    blockCard: {
        padding: spacing.xl,
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        alignItems: 'center',
        gap: spacing.md,
    },
    blockTitle: { fontFamily: fontFamily.display, fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'center' },
    blockSub: { ...textStyles.body, textAlign: 'center' },
    blockPlayerRow: {
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: table.rowHeight,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    blockPlayerName: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    blockPlayerStatus: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dangerDark },
    blockButton: {
        height: controlSize.button.lg.height,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    blockButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
