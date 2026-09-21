import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { FantasyCard } from '@/components/player/FantasyCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { dropPlayer, type PlayerRosterStatus } from '@/lib/roster'
import { loadPickupState } from '@/lib/roster-add-flow'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { addLimitSummary } from '@/lib/pickup'
import { type MemberTransactionState } from '@/lib/league'
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
    }>({ ownerIdentity, transactionState: null })
    const pickupState = pickupStateResource.ownerIdentity === ownerIdentity ? pickupStateResource.transactionState : null
    const [dropping, setDropping] = useState(false)

    useEffect(() => {
        generationRef.current += 1
        setDropping(false)
    }, [ownerIdentity])

    const loadRosterStatus = useCallback(async () => {
        const generation = generationRef.current
        const requestedOwner = ownerIdentity
        setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, error: null })
        if (!current || !leagueId || !requestedOwner) return
        try {
            const { status, transactionState } = await loadPickupState(id, current.id, leagueId)
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource({ ownerIdentity: requestedOwner, status, error: null })
                setPickupStateResource({ ownerIdentity: requestedOwner, transactionState })
            }
        } catch (e) {
            if (isCurrent(generation, requestedOwner)) {
                setRosterStatusResource({ ownerIdentity: requestedOwner, status: null, error: getErrorMessage(e) })
            }
        }
    }, [current, id, leagueId, ownerIdentity])

    useEffect(() => {
        loadRosterStatus()
    }, [loadRosterStatus])

    const openClaim = useCallback(() => push(`/(modals)/claim-player?playerId=${id}`), [push, id])
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        onChanged: loadRosterStatus,
        transactionState: pickupState,
        onClaimInstead: openClaim,
    })

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
                        actionLoading={dropping || quickAdd.adding === id}
                        playedToday={playedToday}
                        addBlockedReason={quickAdd.addBlockedReason}
                        addBlockedCaption={quickAdd.addBlockedReason ? addLimitSummary(pickupState) : null}
                        onAdd={() => quickAdd.handleAdd({ id, display_name: player.display_name })}
                        onDrop={handleDrop}
                        onClaim={() => quickAdd.handleClaim({ id, display_name: player.display_name })}
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
                visible={quickAdd.dropPickerPlayer !== null}
                title={`Drop a player to add\n${quickAdd.dropPickerPlayer?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={quickAdd.myRoster}
                dropping={quickAdd.dropping}
                onDrop={quickAdd.handleDropAndAdd}
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
})
