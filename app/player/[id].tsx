import { canAddToIR } from '@/lib/pickup'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader, type PlayerHeaderAction } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { readPlayerHeader } from '@/components/player/navigation'
import { PlayerHistory } from '@/components/player/PlayerHistory'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { colors, fontSize, fontWeight, layout, spacing, textStyles } from '@/constants/tokens'
import { BackButton, Page, usePageMetrics } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { dropPlayer, type RosterPlayer, type PlayerRosterStatus } from '@/lib/roster'
import { loadPickupState } from '@/lib/roster-add-flow'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { type MemberTransactionState } from '@/lib/league'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { useGoBack } from '@/components/ui/useGoBack'

// Wide enough for a side column of profile stats next to a full game log.
const TWO_COLUMN_MIN = 1000
const SIDE_COLUMN_WIDTH = 400

export default function PlayerDetailScreen() {
    const { id, playerHeader } = useLocalSearchParams<{ id: string; playerHeader?: string }>()
    const tappedPlayer = useMemo(() => readPlayerHeader(id, playerHeader), [id, playerHeader])
    const { current, currentLeague, membershipValidated } = useLeagueContext()
    const online = useOnlineStatus()
    const router = useRouter()
    const { push } = router
    const { padX, usableWidth } = usePageMetrics()
    const twoColumn = usableWidth >= TWO_COLUMN_MIN
    const goBack = useGoBack('/players')

    const memberId = current?.id
    const leagueId = currentLeague?.id ?? null
    const ownerIdentity = current?.id && leagueId ? JSON.stringify([sessionOwner(), sessionGeneration(), current.id, leagueId, id]) : null
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const generationRef = useRef(0)
    activeOwnerRef.current = ownerIdentity
    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        generationRef.current += 1
    }


    const {
        player: loadedPlayer, loading, canRead, readEpoch, isCurrentRead, rosterRevision, includesLive, liveGame,
        playerError,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages, seasonLoading, seasonError,
        gameLog, hasMoreGames, gameLogLoading, loadMoreGames, gameLogError,
        fantasyPointsMap, avgFantasyPoints,
        nextProjection, projectionError, projectionSettled,
        transactions, transactionsError,
    } = usePlayerScreenData(id, leagueId, { ownerKey: ownerIdentity ?? undefined, authorized: membershipValidated, scoringSettings: currentLeague?.scoring_settings })

    const isCurrent = useCallback((generation: number, identity: string | null) =>
        generationRef.current === generation && activeOwnerRef.current === identity && isCurrentRead(readEpoch), [isCurrentRead, readEpoch])

    // Roster status
    const [rosterStatusResource, setRosterStatusResource] = useState<{
        ownerIdentity: string | null
        claimPending?: boolean
        status: PlayerRosterStatus | null
        error: string | null
    }>({ ownerIdentity, status: null, error: null })
    const ownsRosterStatus = rosterStatusResource.ownerIdentity === ownerIdentity
    const rosterStatus = ownsRosterStatus ? rosterStatusResource.status : null
    const rosterStatusError = ownsRosterStatus ? rosterStatusResource.error : null
    // Loaded only once the player turns out to be pick-up-able; a failure here
    // must not hide the roster status, so it is its own resource.
    const [pickupStateResource, setPickupStateResource] = useState<{
        ownerIdentity: string | null
        transactionState: MemberTransactionState | null
        roster?: RosterPlayer[]
    }>({ ownerIdentity, transactionState: null })
    const pickupState = pickupStateResource.ownerIdentity === ownerIdentity ? pickupStateResource.transactionState : null
    const [dropping, setDropping] = useState(false)

    useEffect(() => {
        generationRef.current += 1
        setDropping(false)
    }, [ownerIdentity])

    const statusRequest = useRef<{ epoch: string; queued: boolean } | null>(null)
    const lastStatusSignal = useRef<string | null>(null)
    const loadRosterStatus = useCallback(async function readStatus(): Promise<void> {
        if (!canRead()) return
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        if (!memberId || !leagueId || !requestedOwner) return
        if (statusRequest.current?.epoch === readEpoch) { statusRequest.current.queued = true; return }
        const request = { epoch: readEpoch, queued: false }
        statusRequest.current = request
        try {
            const { status, transactionState, claimPending, roster } = await loadPickupState(id, memberId, leagueId, () => isCurrent(generation, requestedOwner))
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource({ ownerIdentity: requestedOwner, status, claimPending, error: null })
                setPickupStateResource({ ownerIdentity: requestedOwner, transactionState, roster })
            }
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource(previous => previous.ownerIdentity === requestedOwner
                    ? { ...previous, error: getErrorMessage(e) }
                    : { ownerIdentity: requestedOwner, status: null, error: getErrorMessage(e) })
            }
        } finally {
            if (statusRequest.current === request) {
                statusRequest.current = null
                if (request.queued && isCurrent(generation, requestedOwner)) void readStatus()
            }
        }
    }, [memberId, id, leagueId, ownerIdentity, canRead, readEpoch, isCurrent])

    useEffect(() => {
        if (!canRead()) return
        const signal = JSON.stringify([ownerIdentity, rosterRevision])
        if (rosterStatus && lastStatusSignal.current === signal) return
        lastStatusSignal.current = signal
        void loadRosterStatus()
    }, [loadRosterStatus, rosterRevision, canRead, ownerIdentity, rosterStatus])
    const actionsReady = membershipValidated && online && rosterStatus !== null && canRead()

    const openClaim = useCallback(() => push(`/(modals)/claim-player?playerId=${id}`), [push, id])
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        onChanged: loadRosterStatus,
        transactionState: pickupState,
        irSlots: currentLeague?.ir_slots ?? 2,
        allowIR: currentLeague?.status !== 'offseason',
        onClaimInstead: openClaim,
    })

    function handleDrop() {
        if (!actionsReady || rosterStatus?.status !== 'mine') return
        const rosterPlayerId = rosterStatus.rosterPlayerId
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        confirmAction(
            `Drop ${player.display_name}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                if (!isCurrent(generation, requestedOwner)) return
                setDropping(true)
                try {
                    await dropPlayer(rosterPlayerId)
                    if (isCurrent(generation, requestedOwner)) push('/(tabs)/roster')
                } catch (e) {
                    if (isCurrent(generation, requestedOwner)) {
                        showAlert('Error', getErrorMessage(e))
                        setDropping(false)
                    }
                }
            },
            'Drop',
        )
    }

    const player = loadedPlayer ?? tappedPlayer ?? {
        id, display_name: 'Player', first_name: null, last_name: null, nba_team: null,
        position: null, eligible_positions: [], jersey_number: null, injury_status: null,
        dynasty_rank: null, headshot_url: null, nba_id: null, years_exp: null, status: null,
    }
    const showFantasy = leagueId != null
    const showTransactions = leagueId != null && transactions.length > 0
    const action: PlayerHeaderAction | null = !rosterStatus && rosterStatusError ? {
        label: 'Retry', onPress: () => { void loadRosterStatus() }, disabled: !membershipValidated || !online, busy: false,
    } : rosterStatus?.status === 'free_agent' ? {
        label: currentLeague?.status !== 'offseason' && canAddToIR(player.injury_status, ownsRosterStatus ? pickupStateResource.roster ?? [] : [], currentLeague?.ir_slots ?? 2) ? 'Add to IR' : 'Add',
        onPress: () => { if (actionsReady) void quickAdd.handleAdd({ id, display_name: player.display_name, injury_status: player.injury_status }) },
        disabled: !actionsReady, busy: quickAdd.adding === id, blockedReason: quickAdd.addBlockedReason,
    } : rosterStatus?.status === 'on_waivers' ? {
        label: rosterStatusResource.claimPending ? 'View claim' : 'Claim',
        onPress: () => { if (actionsReady) { if (rosterStatusResource.claimPending) push('/roster?claims=1'); else void quickAdd.handleClaim({ id, display_name: player.display_name }) } },
        disabled: !actionsReady, busy: quickAdd.adding === id,
    } : rosterStatus?.status === 'mine' ? {
        label: 'Lineup', onPress: () => push(`/(modals)/lineup?playerId=${encodeURIComponent(id)}`),
        disabled: !actionsReady, busy: false,
    } : null
    const dataWarnings = [
        playerError ? 'Player details could not refresh.' : null,
        rosterStatusError ? 'Roster status could not refresh.' : null,
        seasonError ? 'Season stats could not refresh.' : null,
        gameLogError ? 'Game log could not load more games.' : null,
        projectionError ? 'Projection could not refresh.' : null,
        transactionsError ? 'Transaction history could not refresh.' : null,
    ].filter((message): message is string => message != null)

    const statColumns = 5
    const seasonControl = availableSeasons.length > 1 ? (
        <SeasonSelector
            seasons={availableSeasons}
            selectedSeason={selectedSeason}
            onSelect={handleSeasonSelect}
        />
    ) : null
    const dropControl = rosterStatus?.status === 'mine' ? (
        <Pressable style={styles.dropButton} onPress={handleDrop} disabled={!actionsReady || dropping}
            accessibilityRole="button" accessibilityLabel={`Drop ${player.display_name}`}>
            <Text style={styles.dropText}>Drop</Text>
        </Pressable>
    ) : null
    const profile = (
        <>
            <DeferredContent ready={!seasonLoading} key={`${id}:${selectedSeason}`} style={styles.seasonSlot}
                fallback={<StatsOverview averages={null} seasonYear={selectedSeason} avgFantasyPoints={null} showFantasy={showFantasy}
                    columns={statColumns} seasonControl={seasonControl} actions={dropControl} loading />}>
                <StatsOverview
                    averages={seasonAverages}
                    seasonYear={selectedSeason}
                    avgFantasyPoints={fantasyPointsMap ? avgFantasyPoints : null}
                    showFantasy={showFantasy}
                    columns={statColumns}
                    seasonControl={seasonControl}
                    loading={seasonLoading}
                    includesLive={includesLive}
                    actions={dropControl}
                />
            </DeferredContent>
            <NextProjectionCard projection={nextProjection} loading={!projectionSettled} liveGame={liveGame}
                liveFantasyPoints={liveGame ? fantasyPointsMap?.get(liveGame.gameId) : null} />
        </>
    )
    const gameLogSection = (
        <GameLogTable
            games={gameLog}
            loading={seasonLoading}
            fantasyPointsMap={showFantasy ? fantasyPointsMap : null}
            hasMore={hasMoreGames}
            loadingMore={gameLogLoading}
            onLoadMore={loadMoreGames}
        />
    )
    const historySection = showTransactions ? (
        <PlayerHistory
            key={ownerIdentity}
            playerId={id}
            leagueId={leagueId!}
            transactions={transactions}
        />
    ) : null

    return (
        <>
            <Stack.Screen options={{ title: player.display_name, headerShown: false }} />
            <Page title={player.display_name}>
                <ScrollView contentContainerStyle={[styles.scroll, { paddingHorizontal: padX }]}>
                    <PlayerHeader
                        player={player}
                        rosterStatus={rosterStatus}
                        leagueActive={!!current || !membershipValidated}
                        action={action}
                        backControl={<BackButton onPress={goBack} />}
                        compact={usableWidth < 600}
                    />
                    <View style={styles.body}>
                        {twoColumn ? (
                            <View style={styles.columns}>
                                <View style={styles.sideColumn}>
                                    {profile}
                                </View>
                                <View style={styles.mainColumn}>
                                    {gameLogSection}
                                    {historySection}
                                </View>
                            </View>
                        ) : (
                            <>
                                {profile}
                                {gameLogSection}
                                {historySection}
                            </>
                        )}
                        {dataWarnings.map(message => <Text key={message} style={styles.warningText}>{message}</Text>)}
                        {!loadedPlayer && !loading ? <Text style={styles.errorText}>{playerError ?? 'Player not found.'}</Text> : null}
                    </View>
                </ScrollView>
            </Page>

            <DropPlayerPickerModal
                visible={quickAdd.dropPickerPlayer !== null}
                title={`Make room for\n${quickAdd.dropPickerPlayer?.display_name ?? ''}`}
                subtitle={quickAdd.irMoveCandidates.length ? "Move an Out player to IR or select a drop." : "Your roster is full. Select a player to drop."}
                roster={quickAdd.myRoster}
                dropping={quickAdd.dropping}
                onDrop={quickAdd.handleDropAndAdd}
                irMoveCandidates={quickAdd.irMoveCandidates}
                onMoveToIR={quickAdd.handleMoveToIRAndAdd}
                onCancel={() => quickAdd.setDropPickerPlayer(null)}
            />

            <IRResolutionModal
                visible={quickAdd.irModal !== null}
                ineligibleIR={quickAdd.irModal?.ineligible ?? []}
                activeRoster={(quickAdd.irModal?.roster ?? []).filter((r) => !r.is_on_ir && !r.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={quickAdd.irModal?.pendingPlayer.display_name ?? ''}
                onActivate={quickAdd.handleIRActivate}
                onDropAndActivate={quickAdd.handleDropAndIRActivate}
                onCancel={() => quickAdd.setIrModal(null)}
            />
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    scroll: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing['4xl'], gap: spacing.lg },
    body: { gap: spacing.xl },
    seasonSlot: { flex: 0, minHeight: 0 },
    columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    sideColumn: { width: SIDE_COLUMN_WIDTH, flexShrink: 0, gap: spacing['2xl'] },
    mainColumn: { flex: 1, minWidth: 0, gap: spacing['2xl'] },
    dropButton: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
    dropText: { ...textStyles.meta, color: colors.dangerDark },
    errorText: { ...textStyles.body, textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },
    warningText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
})
