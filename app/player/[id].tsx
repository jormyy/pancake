import { readAssetLocks } from '@/lib/locked-assets'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { listenForMemberClaimsChanges, memberClaimsRevision } from '@/lib/claim-updates'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader, type PlayerHeaderAction } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { readPlayerHeader } from '@/components/player/navigation'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { PlayerSection } from '@/components/player/PlayerSection'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { breakpoints, colors, fontSize, fontWeight, layout, spacing, textStyles } from '@/constants/tokens'
import { BackButton, Page, usePageMetrics } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { useQuickAdd, type PickupClaimSelection } from '@/hooks/use-quick-add'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import { dropPlayer, type RosterPlayer, type PlayerRosterStatus } from '@/lib/roster'
import { loadPickupState } from '@/lib/roster-add-flow'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { type MemberTransactionState } from '@/lib/league'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
    ScrollView,
    Pressable,
    Linking,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { useGoBack } from '@/components/ui/useGoBack'

// Wide enough for a side column of profile stats next to a full game log.
const TWO_COLUMN_MIN = breakpoints.desktop
const SIDE_COLUMN_WIDTH = layout.railWidth

export default function PlayerDetailScreen() {
    const { id, playerHeader, pickupHint } = useLocalSearchParams<{ id: string; playerHeader?: string; pickupHint?: string }>()
    const tappedPlayer = useMemo(() => readPlayerHeader(id, playerHeader), [id, playerHeader])
    const { current, currentLeague, membershipValidated } = useLeagueContext()
    const online = useOnlineStatus()
    const router = useRouter()
    const { push } = router
    const { padX, usableWidth } = usePageMetrics()
    const twoColumn = usableWidth >= TWO_COLUMN_MIN
    const goBack = useGoBack('/players')

    const lockView = useScreenView<RosterView>(membershipValidated && current && currentLeague && sessionOwner()
        ? screenScope('roster', currentLeague.id, current.id, {}, sessionOwner()!) : null)
    const locks = readAssetLocks(lockView.data?.roster.find(row => row.players.id === id))
    const memberId = current?.id
    const leagueId = currentLeague?.id ?? null
    const claimsRevision = useSyncExternalStore(
        useCallback(listener => memberId ? listenForMemberClaimsChanges(memberId, listener) : () => {}, [memberId]),
        useCallback(() => memberId ? memberClaimsRevision(memberId) : 0, [memberId]),
        () => 0,
    )
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
        seasonAverages, seasonLoading, seasonError, gameLogLoading, gameLogError,
        gameLog, hasMoreGames, loadMoreGames,
        fantasyPointsMap, avgFantasyPoints,
        nextProjection, projectionError, projectionSettled,
        transactions, transactionsError, opened, toggleSection, news, newsLoading, newsError, historyLoading, retryGames, retryNews, retryHistory,
    } = usePlayerScreenData(id, leagueId, { ownerKey: current?.id ? JSON.stringify([sessionOwner(), current.id]) : undefined, authorized: membershipValidated, scoringSettings: currentLeague?.scoring_settings })

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
        roster?: Pick<RosterPlayer, 'is_on_ir'>[]
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
            const { status, transactionState, claimPending, roster } = await loadPickupState(id, memberId, leagueId, () => isCurrent(generation, requestedOwner), pickupHint === '1')
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
    }, [memberId, id, leagueId, ownerIdentity, canRead, readEpoch, isCurrent, pickupHint])

    useEffect(() => {
        if (!canRead()) return
        const signal = JSON.stringify([ownerIdentity, rosterRevision, claimsRevision])
        if (rosterStatus && lastStatusSignal.current === signal) return
        lastStatusSignal.current = signal
        void loadRosterStatus()
    }, [loadRosterStatus, rosterRevision, claimsRevision, canRead, ownerIdentity, rosterStatus])
    const actionsReady = membershipValidated && online && rosterStatus !== null && canRead()
    const openClaim = useCallback((_player: unknown, selection?: PickupClaimSelection) => {
        if (selection) push({ pathname: '/(modals)/claim-player', params: { playerId: id, ...selection } })
        else push(`/(modals)/claim-player?playerId=${id}`)
    }, [push, id])
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        onChanged: loadRosterStatus,
        transactionState: pickupState,
        irSlots: currentLeague?.ir_slots ?? 2,
        taxiSlots: currentLeague?.taxi_slots ?? 0,
        rosterSize: currentLeague?.roster_size ?? 20,
        onClaimInstead: openClaim,
    })

    function handleDrop() {
        if (!actionsReady || rosterStatus?.status !== 'mine') return
        const rosterPlayerId = rosterStatus.rosterPlayerId
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        confirmAction(
            `Drop ${player.display_name}?`,
            'They will stay on waivers until the first league-local midnight after 48 hours.',
            async () => {
                if (!isCurrent(generation, requestedOwner)) return
                setDropping(true)
                try {
                    await dropPlayer(rosterPlayerId)
                    if (isCurrent(generation, requestedOwner)) router.dismissTo('/(tabs)/roster')
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
    const showTransactions = leagueId != null
    const action: PlayerHeaderAction | null = !rosterStatus && rosterStatusError ? {
        label: 'Retry', onPress: () => { void loadRosterStatus() }, disabled: !membershipValidated || !online, busy: false,
    } : rosterStatus?.status === 'free_agent' || rosterStatus?.status === 'on_waivers' ? {
        label: rosterStatusResource.claimPending ? 'View claim' : 'Claim',
        onPress: () => { if (actionsReady) { if (rosterStatusResource.claimPending) router.dismissTo('/players?section=waivers'); else void quickAdd.handleClaim(player) } },
        disabled: !actionsReady, busy: quickAdd.adding === id,
    } : rosterStatus?.status === 'mine' ? {
        label: 'Lineup', onPress: () => push(`/(modals)/lineup?playerId=${encodeURIComponent(id)}`),
        disabled: !actionsReady, busy: false,
    } : rosterStatus?.status === 'taken' ? {
        label: 'Trade', onPress: () => { if (actionsReady) push(`/(modals)/propose-trade?requestPlayerId=${encodeURIComponent(id)}`) },
        disabled: !actionsReady, busy: false,
    } : null
    const dataWarnings = [
        playerError ? 'Player details could not refresh.' : null,
        rosterStatusError ? 'Roster status could not refresh.' : null,
        seasonError && seasonError !== gameLogError ? 'Season stats could not refresh.' : null,
        projectionError ? 'Projection could not refresh.' : null,
        transactionsError ? 'Transaction history could not refresh.' : null,
    ].filter((message): message is string => message != null)

    const injuryDetails = loadedPlayer?.injury_status && (loadedPlayer.injury_reason || loadedPlayer.injury_expected_return)
        ? [loadedPlayer.injury_status, loadedPlayer.injury_reason, loadedPlayer.injury_expected_return].filter(Boolean).join(' · ') : null
    const statColumns = 5
    const seasonControl = availableSeasons.length > 1 ? (
        <SeasonSelector
            seasons={availableSeasons}
            selectedSeason={selectedSeason}
            onSelect={handleSeasonSelect}
        />
    ) : null
    const profile = (
        <>
                <StatsOverview
                    averages={seasonAverages}
                    seasonYear={selectedSeason}
                    avgFantasyPoints={avgFantasyPoints}
                    showFantasy={showFantasy}
                    columns={statColumns}
                    seasonControl={seasonControl}
                    loading={seasonLoading}
                    includesLive={includesLive}
                />
            <NextProjectionCard reserveSpace projection={nextProjection} loading={!projectionSettled} liveGame={liveGame}
                liveFantasyPoints={liveGame ? fantasyPointsMap?.get(liveGame.gameId) : null} />
        </>
    )
    const gameLogSection = (
        <GameLogTable
            games={gameLog}
            compact={!twoColumn}
            loading={gameLogLoading}
            fantasyPointsMap={showFantasy ? fantasyPointsMap : null}
            hasMore={hasMoreGames}
            loadingMore={gameLogLoading && gameLog.length > 0}
            loadOnScroll={false}
            onLoadMore={loadMoreGames}
            error={gameLogError}
            onRetry={() => { void retryGames(true) }}
        />
    )
    const historySection = showTransactions ? (
        <PlayerSection title="League history" expanded={opened.history === true} onToggle={() => toggleSection('history')}>
            {historyLoading ? <Text style={textStyles.meta}>Loading history…</Text> : transactionsError ? <Pressable onPress={() => { void retryHistory(true) }}><Text>Retry history</Text></Pressable> : <TransactionHistory key={ownerIdentity} playerId={id} leagueId={leagueId!} transactions={transactions} showHeading={false} />}
        </PlayerSection>
    ) : null

    const lazySections = <>
        <PlayerSection title="Game log" expanded={opened.games === true} onToggle={() => toggleSection('games')}>
            {gameLogSection}
        </PlayerSection>
        <PlayerSection title="News" expanded={opened.news === true} onToggle={() => toggleSection('news')}>
            {newsLoading ? <Text style={textStyles.meta}>Loading news…</Text> : newsError ? <Pressable onPress={() => { void retryNews(true) }}><Text>Retry news</Text></Pressable> : news.length === 0 ? <Text style={textStyles.meta}>No recent news.</Text> : news.map(item => <Pressable key={item.id} accessibilityRole={item.url ? 'link' : undefined} disabled={!item.url} onPress={() => { if (item.url && /^https?:\/\//.test(item.url)) void Linking.openURL(item.url) }} style={styles.newsItem}>
                <Text style={textStyles.rowTitle}>{item.title}</Text>
                <Text style={textStyles.body}>{item.summary}</Text>
                <Text style={textStyles.meta}>{item.source}</Text>
            </Pressable>)}
        </PlayerSection>
        {historySection}
    </>

    return (
        <>
            <Stack.Screen options={{ title: player.display_name, headerShown: false }} />
            <Page title={player.display_name}>
                <View key={ownerIdentity} style={styles.initialSlot}>
                <ScrollView testID="player-detail-scroll" contentContainerStyle={[styles.scroll, { paddingHorizontal: padX }]}>
                    <PlayerHeader locks={locks}
                        player={player}
                        rosterStatus={rosterStatus}
                        ownTeamName={current?.team_name}
                        leagueActive={!!current || !membershipValidated}
                        action={action}
                        onDrop={handleDrop}
                        actionsReady={actionsReady}
                        dropDisabled={dropping}
                        backControl={<BackButton onPress={goBack} />}
                        compact={usableWidth < 600}
                    />
                    <View style={styles.body}>
                        {injuryDetails ? <Text style={textStyles.meta}>{injuryDetails}</Text> : null}
                        {twoColumn ? (
                            <View style={styles.columns}>
                                <View style={styles.sideColumn}>
                                    {profile}
                                </View>
                                <View style={styles.mainColumn}>
                                    {lazySections}
                                </View>
                            </View>
                        ) : (
                            <>
                                {profile}
                                {lazySections}
                            </>
                        )}
                        {dataWarnings.map(message => <Text key={message} style={styles.warningText}>{message}</Text>)}
                        {!loadedPlayer && !loading ? <Text style={styles.errorText}>{playerError ?? 'Player not found.'}</Text> : null}
                    </View>
                </ScrollView>
                </View>
            </Page>

            <DropPlayerPickerModal
                visible={quickAdd.dropPickerPlayer !== null}
                title={`Add ${quickAdd.dropPickerPlayer?.display_name ?? 'player'}`}
                roster={quickAdd.myRoster}
                dropping={quickAdd.dropping ?? quickAdd.adding}
                onDrop={quickAdd.handleDropAndAdd}
                destinations={quickAdd.dropDestinations}
                onAdd={quickAdd.taxiAvailable && quickAdd.canAddActive ? quickAdd.handleAddActive : undefined}
                onAddToTaxi={quickAdd.taxiAvailable ? quickAdd.handleAddToTaxi : undefined}
                irMoveCandidates={quickAdd.irMoveCandidates}
                onMoveToIR={quickAdd.handleMoveToIRAndAdd}
                onCancel={() => quickAdd.setDropPickerPlayer(null)}
            />

            <IRResolutionModal
                visible={quickAdd.irModal !== null}
                serverMessage={quickAdd.irModal?.serverMessage}
                ineligibleIR={quickAdd.irModal?.ineligible ?? []}
                activeRoster={(quickAdd.irModal?.roster ?? []).filter((r) => !r.is_on_ir && !r.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={quickAdd.irModal?.pendingPlayer.display_name ?? ''}
                onActivate={quickAdd.handleIRActivate}
                onDrop={quickAdd.handleResolutionDrop}
                onMoveToIR={quickAdd.handleResolutionMoveToIR}
                irAvailable={(quickAdd.irModal?.roster ?? []).filter(player => player.is_on_ir).length < (currentLeague?.ir_slots ?? 2)}
                onDropAndActivate={quickAdd.handleDropAndIRActivate}
                onCancel={() => quickAdd.setIrModal(null)}
            />
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    newsItem: { paddingVertical: spacing.md, gap: spacing.xs },
    scroll: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingTop: spacing.sm, paddingBottom: spacing['2xl'], gap: spacing.md },
    body: { gap: spacing.md },
    initialSlot: { flex: 1, minHeight: 0 },
    columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    sideColumn: { width: SIDE_COLUMN_WIDTH, flexShrink: 0, gap: spacing.md },
    mainColumn: { flex: 1, minWidth: 0, gap: spacing.md },
    errorText: { ...textStyles.body, textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },
    warningText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
})
