import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { FantasyCard } from '@/components/player/FantasyCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { colors, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { dropAndAddFreeAgent, dropPlayer, getPlayerRosterStatus, type PlayerRosterStatus, type RosterPlayer } from '@/lib/roster'
import { addFreeAgentOrRequestDrop, loadRosterAddGate, resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { ADD_LIMIT_BLOCKED_TITLE, addLimitBlockedMessage, addLimitSummary, getAddLimitStatus, isAddLimitError } from '@/lib/add-limit'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function PlayerDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const { current, currentLeague } = useLeagueContext()
    const { push } = useRouter()

    const leagueId = currentLeague?.id ?? null
    const ownerIdentity = current?.id && leagueId ? `${current.id}:${leagueId}:${id}` : null
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const generationRef = useRef(0)
    activeOwnerRef.current = ownerIdentity
    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        generationRef.current += 1
    }
    const isCurrent = (generation: number, identity: string | null) =>
        generationRef.current === generation && activeOwnerRef.current === identity

    const {
        player, loading, playedToday,
        playerError,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages, seasonLoading, seasonError,
        gameLog, hasMoreGames, gameLogLoading, loadMoreGames, gameLogError,
        fantasyPointsMap, avgFantasyPoints,
        nextProjection, projectionError, projectionSettled,
        transactions, transactionsError, transactionsSettled,
    } = usePlayerScreenData(id, leagueId)

    // Roster status
    const [rosterStatusResource, setRosterStatusResource] = useState<{
        ownerIdentity: string | null
        status: PlayerRosterStatus | null
        transactionState: MemberTransactionState | null
        error: string | null
    }>({ ownerIdentity, status: null, transactionState: null, error: null })
    const ownsRosterStatus = rosterStatusResource.ownerIdentity === ownerIdentity
    const rosterStatus = ownsRosterStatus ? rosterStatusResource.status : null
    const rosterStatusError = ownsRosterStatus ? rosterStatusResource.error : null
    const addLimit = getAddLimitStatus(ownsRosterStatus ? rosterStatusResource.transactionState : null)
    const addBlockedReason = addLimit?.reached ? addLimitBlockedMessage(addLimit) : null
    const [actionLoading, setActionLoading] = useState(false)

    // Drop picker + IR resolution state
    const [dropPickerVisible, setDropPickerVisible] = useState(false)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)
    const [irModal, setIrModal] = useState<{
        ineligible: RosterPlayer[]
        roster: RosterPlayer[]
        // Which flow opened the IR modal, so the continuation resumes the right
        // action once IR is resolved (add a free agent vs. submit a waiver claim).
        action: 'add' | 'claim'
    } | null>(null)
    const [actionStateOwner, setActionStateOwner] = useState(ownerIdentity)
    const ownsActionState = actionStateOwner === ownerIdentity

    useEffect(() => {
        generationRef.current += 1
        setActionStateOwner(ownerIdentity)
        setActionLoading(false)
        setDropPickerVisible(false)
        setMyRoster([])
        setDropping(null)
        setIrModal(null)
    }, [ownerIdentity])

    const loadRosterStatus = useCallback(async () => {
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, transactionState: null, error: null })
        if (!current || !leagueId || !requestedOwner) return
        try {
            const [status, transactionState] = await Promise.all([
                getPlayerRosterStatus(id, current.id, leagueId),
                getMemberTransactionState(current.id, leagueId),
            ])
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource({ ownerIdentity: requestedOwner, status, transactionState, error: null })
            }
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, transactionState: null, error: getErrorMessage(e) })
            }
        }
    }, [current, id, leagueId, ownerIdentity])

    // Explains a blocked pickup from cached state; the server stays authoritative
    // and its own rejection (a stale client, a slot consumed elsewhere) is shown
    // through the same title.
    function explainAddLimitBlock(): boolean {
        if (!addBlockedReason) return false
        showAlert(ADD_LIMIT_BLOCKED_TITLE, addBlockedReason)
        void loadRosterStatus()
        return true
    }

    function reportPickupError(e: unknown) {
        const message = getErrorMessage(e)
        if (isAddLimitError(message)) {
            setDropPickerVisible(false)
            showAlert(ADD_LIMIT_BLOCKED_TITLE, message)
            void loadRosterStatus()
            return
        }
        showAlert('Error', message)
    }

    useEffect(() => {
        loadRosterStatus()
    }, [loadRosterStatus])

    async function handleAdd() {
        if (!current || !leagueId) return
        if (explainAddLimitBlock()) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        setActionLoading(true)
        try {
            const { roster, ineligible } = await loadRosterAddGate(current.id, leagueId)
            if (!isCurrent(generation, requestedOwner)) return

            if (ineligible.length > 0) {
                setActionLoading(false)
                setIrModal({ ineligible, roster, action: 'add' })
                return
            }

            await tryAddFreeAgent()
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) showAlert('Error', getErrorMessage(e))
        } finally {
            if (isCurrent(generation, requestedOwner)) setActionLoading(false)
        }
    }

    async function tryAddFreeAgent() {
        if (!current || !leagueId) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        setActionLoading(true)
        try {
            const result = await addFreeAgentOrRequestDrop(current.id, leagueId, id)
            if (!isCurrent(generation, requestedOwner)) return
            if (result.status === 'roster_full') {
                setMyRoster(result.activeRoster)
                setDropPickerVisible(true)
            } else {
                await loadRosterStatus()
            }
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) reportPickupError(e)
        } finally {
            if (isCurrent(generation, requestedOwner)) setActionLoading(false)
        }
    }

    // This intentionally uses the current render's mutation function. The route
    // can stay mounted while the selected league changes.
    function continueAfterIR(action: 'add' | 'claim') {
        if (action === 'claim') push(`/(modals)/claim-player?playerId=${id}`)
        else void tryAddFreeAgent()
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!current || !leagueId) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        setDropping(rosterPlayer.id)
        try {
            await dropAndAddFreeAgent(rosterPlayer.id, current.id, leagueId, id)
            if (!isCurrent(generation, requestedOwner)) return
            setDropPickerVisible(false)
            await loadRosterStatus()
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) reportPickupError(e)
        } finally {
            if (isCurrent(generation, requestedOwner)) setDropping(null)
        }
    }

    async function handleIRActivate(rp: RosterPlayer) {
        if (!current || !leagueId) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        try {
            const result = await resolveRosterAddIRConflict({
                memberId: current.id,
                leagueId,
                activatePlayer: rp,
            })
            if (!isCurrent(generation, requestedOwner)) return
            if (result.status === 'locked') {
                showAlert('Roster locked', result.message)
                return
            }

            if (result.remaining.length > 0) {
                setIrModal((prev) => prev ? { ...prev, ineligible: result.remaining, roster: result.roster } : null)
            } else {
                const action = irModal?.action ?? 'add'
                setIrModal(null)
                continueAfterIR(action)
            }
        } catch (e) {
            if (!isCurrent(generation, requestedOwner)) return
            // Keep modal open so user can retry — but refresh its state in case
            // the failure left the roster in an unexpected shape.
            showAlert('Could not activate from IR', getErrorMessage(e) ?? 'Unknown error')
            try {
                const { roster, ineligible } = await loadRosterAddGate(current.id, leagueId)
                if (isCurrent(generation, requestedOwner)) {
                    setIrModal((prev) => prev ? { ...prev, ineligible, roster } : null)
                }
            } catch (refreshError) {
                if (isCurrent(generation, requestedOwner)) {
                    setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, error: getErrorMessage(refreshError) })
                }
            }
        }
    }

    async function handleDropAndIRActivate(toDrop: RosterPlayer, activatePlayer: RosterPlayer) {
        if (!current || !leagueId) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        try {
            const result = await resolveRosterAddIRConflict({
                memberId: current.id,
                leagueId,
                activatePlayer,
                dropPlayer: toDrop,
            })
            if (!isCurrent(generation, requestedOwner)) return
            if (result.status === 'locked') {
                showAlert('Roster locked', result.message)
                return
            }

            if (result.remaining.length > 0) {
                setIrModal((prev) => prev ? { ...prev, ineligible: result.remaining, roster: result.roster } : null)
            } else {
                const action = irModal?.action ?? 'add'
                setIrModal(null)
                continueAfterIR(action)
            }
        } catch (e) {
            if (!isCurrent(generation, requestedOwner)) return
            const underlying = getErrorMessage(e) ?? 'Unknown error'
            showAlert('Could not update roster', underlying)
            // Refresh modal state to reflect actual roster after the failed transaction.
            try {
                const { roster, ineligible } = await loadRosterAddGate(current.id, leagueId)
                if (isCurrent(generation, requestedOwner)) {
                    setIrModal((prev) => prev ? { ...prev, ineligible, roster } : null)
                }
            } catch (refreshError) {
                if (isCurrent(generation, requestedOwner)) {
                    setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, error: getErrorMessage(refreshError) })
                }
            }
        }
    }

    function handleDrop() {
        if (rosterStatus?.status !== 'mine') return
        const rosterPlayerId = rosterStatus.rosterPlayerId
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        confirmAction(
            `Drop ${player?.display_name ?? 'this player'}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                if (!isCurrent(generation, requestedOwner)) return
                setActionLoading(true)
                try {
                    await dropPlayer(rosterPlayerId)
                    if (isCurrent(generation, requestedOwner)) push('/(tabs)/roster')
                } catch (e) {
                    if (isCurrent(generation, requestedOwner)) {
                        showAlert('Error', getErrorMessage(e))
                        setActionLoading(false)
                    }
                }
            },
            'Drop',
        )
    }

    async function handleClaim() {
        if (!current || !leagueId) return
        if (explainAddLimitBlock()) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        // Check for ineligible IR players before allowing waiver claim
        const { roster, ineligible } = await loadRosterAddGate(current.id, leagueId)
        if (!isCurrent(generation, requestedOwner)) return

        if (ineligible.length > 0) {
            setIrModal({ ineligible, roster, action: 'claim' })
            return
        }

        push(`/(modals)/claim-player?playerId=${id}`)
    }

    if (!player) {
        return (
            <SafeAreaView style={styles.container}>
                <Stack.Screen options={{ title: 'Player', headerBackTitle: 'Back' }} />
                {!loading ? <Text style={styles.errorText}>{playerError ?? 'Player not found.'}</Text> : null}
            </SafeAreaView>
        )
    }

    const showFantasy = leagueId != null && fantasyPointsMap !== null && fantasyPointsMap.size > 0
    const showTransactions = leagueId != null && transactions.length > 0
    // Hold the body until every card's presence is known, so the page appears
    // fully formed instead of cards popping in one by one and shifting layout.
    const contentReady = !loading && !seasonLoading && projectionSettled && transactionsSettled
    const dataWarnings = [
        playerError ? 'Player details could not refresh.' : null,
        rosterStatusError ? 'Roster status could not refresh.' : null,
        seasonError ? 'Season stats could not refresh.' : null,
        gameLogError ? 'Game log could not load more games.' : null,
        projectionError ? 'Projection could not refresh.' : null,
        transactionsError ? 'Transaction history could not refresh.' : null,
    ].filter((message): message is string => message != null)

    return (
        <>
            <Stack.Screen options={{ title: player.display_name, headerBackTitle: 'Back' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <ScrollView contentContainerStyle={styles.scroll}>

                    {/* Header */}
                    <PlayerHeader
                        player={player}
                        rosterStatus={rosterStatus}
                        leagueActive={!!current}
                        actionLoading={ownsActionState ? actionLoading : false}
                        playedToday={playedToday}
                        addBlockedReason={addBlockedReason}
                        addBlockedCaption={addLimit?.reached ? addLimitSummary(addLimit) : null}
                        onAdd={handleAdd}
                        onDrop={handleDrop}
                        onClaim={handleClaim}
                        onSetLineup={() => push(`/(modals)/lineup?playerId=${encodeURIComponent(id)}`)}
                    />

                    {contentReady ? (
                        <>
                            {dataWarnings.map((message) => (
                                <View key={message} style={styles.warningBanner}>
                                    <Text style={styles.warningText}>{message}</Text>
                                </View>
                            ))}

                            {nextProjection ? <NextProjectionCard projection={nextProjection} /> : null}

                            {/* Season selector */}
                            <SeasonSelector
                                seasons={availableSeasons}
                                selectedSeason={selectedSeason}
                                onSelect={handleSeasonSelect}
                            />
                            {/* Season averages */}
                            {seasonAverages ? (
                                <StatsOverview
                                    averages={seasonAverages}
                                    seasonYear={selectedSeason}
                                />
                            ) : (
                                <View style={styles.section}>
                                    <Text style={styles.sectionTitle}>
                                        {selectedSeason - 1}–{String(selectedSeason).slice(2)} Averages
                                    </Text>
                                    <Text style={styles.noData}>No stats available.</Text>
                                </View>
                            )}

                            {/* Fantasy context */}
                            {showFantasy && (
                                <FantasyCard
                                    avgFantasyPoints={avgFantasyPoints}
                                    gamesCount={fantasyPointsMap!.size}
                                />
                            )}

                            {/* Game log */}
                            <GameLogTable
                                games={gameLog}
                                fantasyPointsMap={showFantasy ? fantasyPointsMap : null}
                                hasMore={hasMoreGames}
                                loadingMore={gameLogLoading}
                                onLoadMore={loadMoreGames}
                            />

                            {/* Transaction history — always shown regardless of season */}
                            {showTransactions && (
                                <TransactionHistory
                                    playerId={id}
                                    leagueId={leagueId!}
                                    transactions={transactions}
                                />
                            )}
                        </>
                    ) : null}

                </ScrollView>
            </SafeAreaView>

            <DropPlayerPickerModal
                visible={ownsActionState && dropPickerVisible}
                title={`Drop a player to add\n${player?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={ownsActionState ? myRoster : []}
                dropping={ownsActionState ? dropping : null}
                onDrop={handleDropAndAdd}
                onCancel={() => setDropPickerVisible(false)}
            />

            {/* IR resolution modal */}
            <IRResolutionModal
                visible={ownsActionState && irModal !== null}
                ineligibleIR={ownsActionState ? irModal?.ineligible ?? [] : []}
                activeRoster={(ownsActionState ? irModal?.roster ?? [] : []).filter((r) => !r.is_on_ir && !r.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={player?.display_name ?? ''}
                onActivate={handleIRActivate}
                onDropAndActivate={handleDropAndIRActivate}
                onCancel={() => setIrModal(null)}
            />
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { padding: spacing['2xl'], gap: spacing['3xl'], width: '100%', maxWidth: 900, alignSelf: 'center' },
    section: { gap: spacing.lg },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    noData: { color: colors.textPlaceholder, fontSize: fontSize.md },
    errorText: { textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },
    warningBanner: {
        backgroundColor: colors.dangerLight,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
    },
    warningText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },

    // Drop picker modal
    modalOverlay: {
        flex: 1,
        backgroundColor: scrim,
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    modalPlayerName: { color: colors.primaryDark },
    modalSub: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginBottom: spacing.xl },
    dropList: { maxHeight: 360 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.lg,
    },
    dropInfo: { flex: 1 },
    dropName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    dropMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
    dropMeta: { fontSize: 12, color: colors.textMuted },
    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
    modalCancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
