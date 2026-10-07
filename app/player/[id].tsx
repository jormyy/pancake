import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { NextProjectionCard } from '@/components/player/NextProjectionCard'
import { colors, fontSize, fontWeight, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { Page, usePageMetrics } from '@/components/ui'
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
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'

// Wide enough for a side column of profile stats next to a full game log.
const TWO_COLUMN_MIN = 1000
const SIDE_COLUMN_WIDTH = 400

export default function PlayerDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>()
    const { current, currentLeague } = useLeagueContext()
    const router = useRouter()
    const { push } = router
    const { padX, usableWidth } = usePageMetrics()
    const twoColumn = usableWidth >= TWO_COLUMN_MIN
    // The installed iPhone app has no back swipe, and a deep link has no history.
    const goBack = useCallback(() => {
        if (router.canGoBack()) router.back()
        else router.replace('/players')
    }, [router])

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
            <Page title="Player">
                <Stack.Screen options={{ title: 'Player', headerShown: false }} />
                <View style={[styles.missingHeader, { paddingHorizontal: padX }]}>
                    <BackButton onPress={goBack} />
                </View>
                {!loading ? <Text style={styles.errorText}>{playerError ?? 'Player not found.'}</Text> : null}
            </Page>
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

    const statColumns = twoColumn || usableWidth < 700 ? 4 : 6
    const profile = (
        <>
            {nextProjection ? <NextProjectionCard projection={nextProjection} /> : null}
            <SeasonSelector
                seasons={availableSeasons}
                selectedSeason={selectedSeason}
                onSelect={handleSeasonSelect}
            />
            {seasonAverages ? (
                <StatsOverview
                    averages={seasonAverages}
                    seasonYear={selectedSeason}
                    avgFantasyPoints={showFantasy ? avgFantasyPoints : null}
                    columns={statColumns}
                />
            ) : (
                <View style={styles.section}>
                    <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>
                        {selectedSeason - 1}–{String(selectedSeason).slice(2)} Averages
                    </Text>
                    <Text style={styles.noData}>No stats available.</Text>
                </View>
            )}
        </>
    )
    const gameLogSection = (
        <GameLogTable
            games={gameLog}
            fantasyPointsMap={showFantasy ? fantasyPointsMap : null}
            hasMore={hasMoreGames}
            loadingMore={gameLogLoading}
            onLoadMore={loadMoreGames}
        />
    )
    const historySection = showTransactions ? (
        <TransactionHistory
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
                    <View style={styles.headerRow}>
                    <BackButton onPress={goBack} />
                    <View style={styles.headerMain}>
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
                        compact={usableWidth < 600}
                    />
                    </View>
                    </View>

                    {contentReady ? (
                        <>
                            {dataWarnings.map((message) => (
                                <View key={message} style={styles.warningBanner}>
                                    <Text style={styles.warningText}>{message}</Text>
                                </View>
                            ))}

                            {twoColumn ? (
                                <View style={styles.columns}>
                                    <View style={styles.sideColumn}>
                                        {profile}
                                        {historySection}
                                    </View>
                                    <View style={styles.mainColumn}>{gameLogSection}</View>
                                </View>
                            ) : (
                                <>
                                    {profile}
                                    {gameLogSection}
                                    {historySection}
                                </>
                            )}
                        </>
                    ) : null}
                </ScrollView>
            </Page>

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

function BackButton({ onPress }: { onPress: () => void }) {
    return (
        <Pressable onPress={onPress} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </Pressable>
    )
}

const styles = StyleSheet.create({
    scroll: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingTop: spacing.lg, paddingBottom: spacing['4xl'], gap: spacing['2xl'] },
    columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    sideColumn: { width: SIDE_COLUMN_WIDTH, flexShrink: 0, gap: spacing['2xl'] },
    mainColumn: { flex: 1, minWidth: 0, gap: spacing['2xl'] },
    section: { gap: spacing.md },
    noData: { ...textStyles.body, color: colors.textPlaceholder },
    missingHeader: { paddingTop: spacing.lg },
    headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    headerMain: { flex: 1, minWidth: 0 },
    back: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    errorText: { ...textStyles.body, textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },
    warningBanner: {
        backgroundColor: colors.dangerLight,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
    },
    warningText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
})
