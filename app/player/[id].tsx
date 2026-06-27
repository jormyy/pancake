import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { LoadingScreen } from '@/components/LoadingScreen'
import { FantasyCard } from '@/components/player/FantasyCard'
import { GameLogTable } from '@/components/player/GameLogTable'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { SeasonSelector } from '@/components/player/SeasonSelector'
import { StatsOverview } from '@/components/player/StatsOverview'
import { TransactionHistory } from '@/components/player/TransactionHistory'
import { colors, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { usePlayerScreenData } from '@/hooks/use-player-screen-data'
import { addFreeAgent, dropPlayer, getPlayerRosterStatus, getRoster, toggleIR, type PlayerRosterStatus, type RosterPlayer } from '@/lib/roster'
import { isIneligibleIR } from '@/lib/format'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
    ActivityIndicator,
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

    const {
        player, loading, playedToday,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages, seasonLoading,
        gameLog, hasMoreGames, gameLogLoading, loadMoreGames,
        fantasyPointsMap, avgFantasyPoints,
        transactions,
    } = usePlayerScreenData(id, leagueId)

    // Roster status
    const [rosterStatus, setRosterStatus] = useState<PlayerRosterStatus | null>(null)
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

    // Resume the originating flow after the IR conflict is cleared.
    const continueAfterIR = useCallback(
        (action: 'add' | 'claim') => {
            if (action === 'claim') push(`/(modals)/claim-player?playerId=${id}`)
            else tryAddFreeAgent()
        },
        // tryAddFreeAgent/push/id are stable enough for this modal flow
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id],
    )

    const loadRosterStatus = useCallback(async () => {
        if (!current || !leagueId) return
        try {
            const status = await getPlayerRosterStatus(id, current.id, leagueId)
            setRosterStatus(status)
        } catch (e) {
            console.error(e)
        }
    }, [current, id, leagueId])

    useEffect(() => {
        loadRosterStatus()
    }, [loadRosterStatus])

    async function handleAdd() {
        if (!current || !leagueId) return
        setActionLoading(true)
        try {
            // Check for ineligible IR players before adding
            const roster = await getRoster(current.id, leagueId)
            const ineligible = roster.filter((r) => isIneligibleIR(r))

            if (ineligible.length > 0) {
                setActionLoading(false)
                setIrModal({ ineligible, roster, action: 'add' })
                return
            }

            await tryAddFreeAgent()
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setActionLoading(false)
        }
    }

    async function tryAddFreeAgent() {
        if (!current || !leagueId) return
        setActionLoading(true)
        try {
            await addFreeAgent(current.id, leagueId, id)
            await loadRosterStatus()
        } catch (e) {
            if (getErrorMessage(e)?.includes('full')) {
                const roster = await getRoster(current.id, leagueId)
                setMyRoster(roster.filter((r) => !r.is_on_ir && !r.is_on_taxi))
                setDropPickerVisible(true)
            } else {
                showAlert('Error', getErrorMessage(e))
            }
        } finally {
            setActionLoading(false)
        }
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!current || !leagueId) return
        setDropping(rosterPlayer.id)
        try {
            await dropPlayer(rosterPlayer.id)
            await addFreeAgent(current.id, leagueId, id)
            setDropPickerVisible(false)
            await loadRosterStatus()
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setDropping(null)
        }
    }

    async function handleIRActivate(rp: RosterPlayer) {
        if (!current || !leagueId) return
        try {
            const lockMessage = await getRosterStatusChangeLockMessage(rp)
            if (lockMessage) {
                showAlert('Roster locked', lockMessage)
                return
            }

            await toggleIR(rp.id, false)
            const roster = await getRoster(current.id, leagueId)
            const remaining = roster.filter((r) => isIneligibleIR(r))
            if (remaining.length > 0) {
                setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
            } else {
                const action = irModal?.action ?? 'add'
                setIrModal(null)
                continueAfterIR(action)
            }
        } catch (e) {
            // Keep modal open so user can retry — but refresh its state in case
            // the failure left the roster in an unexpected shape.
            showAlert('Could not activate from IR', getErrorMessage(e) ?? 'Unknown error')
            try {
                const roster = await getRoster(current.id, leagueId)
                const remaining = roster.filter((r) => isIneligibleIR(r))
                setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
            } catch {
                // best-effort refresh; swallow secondary failures
            }
        }
    }

    async function handleDropAndIRActivate(toDrop: RosterPlayer, activatePlayer: RosterPlayer) {
        if (!current || !leagueId) return
        let dropped = false
        try {
            const lockMessage = await getRosterStatusChangeLockMessage(activatePlayer)
            if (lockMessage) {
                showAlert('Roster locked', lockMessage)
                return
            }

            await dropPlayer(toDrop.id)
            dropped = true
            await toggleIR(activatePlayer.id, false)
            const roster = await getRoster(current.id, leagueId)
            const remaining = roster.filter((r) => isIneligibleIR(r))
            if (remaining.length > 0) {
                setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
            } else {
                const action = irModal?.action ?? 'add'
                setIrModal(null)
                continueAfterIR(action)
            }
        } catch (e) {
            const underlying = getErrorMessage(e) ?? 'Unknown error'
            if (dropped) {
                // Half-committed: drop succeeded but IR activation failed. Make
                // it crystal clear so the user knows their roster changed.
                const droppedName = toDrop.players?.display_name ?? 'Player'
                const activateName = activatePlayer.players?.display_name ?? 'the IR player'
                showAlert(
                    'Partial failure',
                    `${droppedName} was dropped to free agency, but activating ${activateName} failed: ${underlying}`,
                )
            } else {
                showAlert('Could not drop player', underlying)
            }
            // Refresh modal state to reflect actual roster after the partial change.
            try {
                const roster = await getRoster(current.id, leagueId)
                const remaining = roster.filter((r) => isIneligibleIR(r))
                setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
            } catch {
                // best-effort refresh; swallow secondary failures
            }
        }
    }

    function handleDrop() {
        if (rosterStatus?.status !== 'mine') return
        const rosterPlayerId = rosterStatus.rosterPlayerId
        confirmAction(
            `Drop ${player?.display_name ?? 'this player'}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                setActionLoading(true)
                try {
                    await dropPlayer(rosterPlayerId)
                    push('/(tabs)/roster')
                } catch (e) {
                    showAlert('Error', getErrorMessage(e))
                    setActionLoading(false)
                }
            },
            'Drop',
        )
    }

    async function handleClaim() {
        if (!current || !leagueId) return
        // Check for ineligible IR players before allowing waiver claim
        const roster = await getRoster(current.id, leagueId)
        const ineligible = roster.filter((r) => isIneligibleIR(r))

        if (ineligible.length > 0) {
            setIrModal({ ineligible, roster, action: 'claim' })
            return
        }

        push(`/(modals)/claim-player?playerId=${id}`)
    }

    if (loading) {
        return <LoadingScreen />
    }

    if (!player) {
        return (
            <SafeAreaView style={styles.container}>
                <Text style={styles.errorText}>Player not found.</Text>
            </SafeAreaView>
        )
    }

    const showFantasy = leagueId != null && fantasyPointsMap !== null && fantasyPointsMap.size > 0
    const showTransactions = leagueId != null && transactions.length > 0

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
                        actionLoading={actionLoading}
                        playedToday={playedToday}
                        onAdd={handleAdd}
                        onDrop={handleDrop}
                        onClaim={handleClaim}
                    />

                    {/* Season selector */}
                    <SeasonSelector
                        seasons={availableSeasons}
                        selectedSeason={selectedSeason}
                        onSelect={handleSeasonSelect}
                    />

                    {seasonLoading ? (
                        <ActivityIndicator color={colors.primary} style={styles.seasonLoader} />
                    ) : (
                        <>
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
                        </>
                    )}

                    {/* Transaction history — always shown regardless of season */}
                    {showTransactions && (
                        <TransactionHistory
                            playerId={id}
                            leagueId={leagueId!}
                            transactions={transactions}
                        />
                    )}

                </ScrollView>
            </SafeAreaView>

            <DropPlayerPickerModal
                visible={dropPickerVisible}
                title={`Drop a player to add\n${player?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={myRoster}
                dropping={dropping}
                onDrop={handleDropAndAdd}
                onCancel={() => setDropPickerVisible(false)}
            />

            {/* IR resolution modal */}
            <IRResolutionModal
                visible={irModal !== null}
                ineligibleIR={irModal?.ineligible ?? []}
                activeRoster={(irModal?.roster ?? []).filter((r) => !r.is_on_ir && !r.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={player?.display_name ?? ''}
                onActivate={handleIRActivate}
                onDropAndActivate={handleDropAndIRActivate}
                onCancel={() => setIrModal(null)}
            />
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { padding: spacing['2xl'], gap: spacing['3xl'], width: '100%', maxWidth: 900, alignSelf: 'center' },
    seasonLoader: { marginVertical: spacing['4xl'] },
    section: { gap: spacing.lg },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    noData: { color: colors.textPlaceholder, fontSize: fontSize.md },
    errorText: { textAlign: 'center', marginTop: spacing['5xl'], color: colors.textMuted },

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
