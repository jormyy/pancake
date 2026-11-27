import { ListHeader } from '@/components/ui/ListHeader'
import { RookiePickRow, rookiePickRowStyles } from '@/components/league/draft-room/RookiePickRow'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { ScreenFrame } from '@/components/ui/ScreenFrame'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { type RookieClassStatus, type RookieDestination, type RookieProspect, type SnakePick } from '@/lib/rookieDraft'
import { type RookieSelection, type RookieSelectionOutcome } from '@/hooks/useRookieDraftRoomController'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { draftYearForSeason, leagueSeasonYear } from '@/lib/picks'
import { breakpoints, colors, controlSize, fontWeight, layout, radii, spacing, table, textStyles, uiColors, typeScale } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { showSuccess } from '@/lib/alert'
import { countLabel } from '@/lib/format'

import { DraftAdminBar } from '@/components/league/draft-room/DraftAdminBar'
import { DraftScreenHeader } from '@/components/league/draft-room/DraftScreenHeader'
import { DraftNotFoundState } from '@/components/league/draft-room/DraftNotFoundState'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import { SettingsRow, SettingsToggle } from '@/components/settings/SettingsGroup'

import { ErrorBanner } from '@/components/ui/ErrorBanner'
import { LoadingState } from '@/components/ui/LoadingState'
import { partitionRoster, planRookiePlacement, rosterLimits, type RosterLimits } from '@/lib/roster-capacity'
import type { RosterPlayer } from '@/lib/roster'

export default function RookieDraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, currentLeague, isCommissioner } = useLeagueContext()
    const limits = rosterLimits(currentLeague)
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    // Wide screens keep one readable column and move admin controls into the header.
    const isDesktop = width >= breakpoints.desktop && !compactLandscape
    const myMemberId = current?.id

    const {
        state,
        actionsReady,
        canAct,
        loading,
        loadError,
        prospectsLoadError,
        query,
        setQuery,
        prospects,
        prospectsLoading,
        picking,
        draftToTaxi,
        setDraftToTaxi,
        activeTab,
        setActiveTab,
        secondsLeft,
        pickError,
        completionError,
        rosterOverflow,
        rosterForDrop,
        resolvingOverflow,
        trimOverflow,
        trimmingId,
        trimAwaitingLimits,
        memberId,
        refresh,
        handleTrimDrop,
        handlePick,
        handleCommissionerPick,
        resolveByDrop,
        selection,
        selectionOutcome,
        beginSelection,
        chooseSelectionDestination,
        toggleSelectionDrop,
        cancelSelection,
        confirmSelection,
    } = useRookieDraftRoomController({
        draftId,
        memberId: myMemberId,
        leagueId: currentLeague?.id,
        rosterSize: limits?.rosterSize ?? null,
    })

    const { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft, adminBusy } =
        useDraftAdminControls({
            canAct,
            draftId,
            refresh,
            onStopped: () => navigateBackToDraftList(),
            onReset: () => showSuccess('Draft Reset', 'The rookie draft has been reset to the first pick.'),
            confirmCopy: {
                stop: 'This ends the rookie draft now. Players already drafted stay on their rosters. The season starts after every roster fits or at the opening-night deadline. This cannot be undone.',
                reset: 'This clears every pick, returns all pick assets, and restarts the draft from the first selection. This cannot be undone.',
                pause: 'This freezes the pick clock until the commissioner resumes the draft.',
                resume: 'This restarts the draft clock and allows picks again.',
            },
        })

    function navigateBackToDraftList() {
        router.dismissTo('/league?tab=draft')
    }

    if (!state) {
        return (
            <>
                <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal', headerShown: false }} />
                <ScreenFrame style={styles.container}>
                    <DraftScreenHeader title="Rookie Draft" onBack={() => navigateBackToDraftList()} />
                    {loading || loadError ? <View style={styles.center}>
                        {loading ? <LoadingState /> : (
                            <ErrorBanner message="Could not load this draft. Tap to retry." onRetry={() => { void refresh() }} />
                        )}
                    </View> : <DraftNotFoundState onBack={navigateBackToDraftList} />}
                </ScreenFrame>
            </>
        )
    }

    if (state.draft.leagueId !== currentLeague?.id) {
        return <ScreenFrame style={styles.container}>
            <DraftScreenHeader title="Rookie Draft" onBack={() => navigateBackToDraftList()} />
            <View style={styles.center}>
                <Text style={styles.emptyText}>This draft belongs to another league. Select its league to continue.</Text>
            </View>
        </ScreenFrame>
    }

    const { draft, picks, nextPick } = state
    const isMyTurn = nextPick?.memberId === memberId
    const stopped = draft.status === 'cancelled'
    const isPaused = draft.status === 'paused'
    const isDone = draft.status === 'completed' || stopped
    const canCommissionerPick =
        isCommissioner && isPaused && draft.pauseReason === 'timer_expired_commissioner_pick' && !!nextPick
    const canUsePauseControl = !canCommissionerPick
    const pickTimerExpired =
        draft.status === 'in_progress' && !!nextPick?.timerExpiresAt && secondsLeft === 0
    const draftTitle = `${draft.seasonYear == null ? '' : `${draftYearForSeason(leagueSeasonYear(draft.seasonYear))} `}${draft.isMock ? 'Mock Rookie Draft' : 'Rookie Draft'}`

    const isPending = draft.status === 'pending'
    const totalPicks = picks.length
    const madePicks = picks.filter((p) => p.player || p.skippedAt).length
    const currentRound = nextPick?.round
        ?? (state.orders.length > 0 ? Math.ceil(totalPicks / state.orders.length) : 1)
    const upNext = nextPick ? picks.find(pick => pick.overallPick > nextPick.overallPick && !pick.player && !pick.skippedAt) ?? null : null
    const classYear = draft.seasonYear == null ? null : draftYearForSeason(leagueSeasonYear(draft.seasonYear))
    const classNotice = rookieClassNotice(state.classStatus ?? null, classYear)
    const choosesPlacement = !draft.isMock && isMyTurn && !canCommissionerPick

    return (
        <>
            <Stack.Screen options={{ title: draftTitle, presentation: 'modal', headerShown: false }} />

            <Sheet visible={!!rosterOverflow} title="Roster Full"
                onClose={() => { if (!resolvingOverflow) navigateBackToDraftList() }}>
                <View style={styles.overflowCard}>
                    <Text style={styles.overflowBody}>
                        You drafted{' '}
                        <Text style={{ fontWeight: fontWeight.bold }}>{rosterOverflow?.newPlayerName}</Text>
                        {' '}but your active roster is over capacity. Drop a player before setting lineups or adding players.
                    </Text>
                    <Button variant="secondary" title="Back to League" accessibilityLabel="Back to League"
                        disabled={resolvingOverflow} onPress={() => navigateBackToDraftList()} />
                    {rosterForDrop.length > 0 && (
                        <>
                            <Text style={styles.overflowDropLabel}>Drop a player:</Text>
                            <View>
                                {rosterForDrop.map((rp) => (
                                    <MotionPressable
                                        key={rp.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Drop ${rp.players?.display_name ?? 'Player'}`}
                                        style={styles.overflowDropRow}
                                        onPress={() => resolveByDrop(rp.id)}
                                        disabled={resolvingOverflow || !actionsReady}
                                    >
                                        <PlayerRowContent name={rp.players?.display_name ?? 'Player'} nbaId={rp.players?.nba_id} team={rp.players?.nba_team}
                                            positions={rp.players?.position ? [rp.players.position] : []}
                                            birthdate={rp.players?.birthdate} yearsExp={rp.players?.years_exp} careerGames={rp.players?.career_regular_season_games} injuryStatus={rp.players?.injury_status} />
                                    </MotionPressable>
                                ))}
                            </View>
                        </>
                    )}
                </View>
            </Sheet>

            <Sheet visible={!!trimOverflow || trimAwaitingLimits} title="Trim Your Roster"
                onClose={() => { if (!trimmingId) navigateBackToDraftList() }}>
                <View style={styles.overflowCard}>
                    {trimOverflow ? (
                        <Text style={styles.overflowBody}>
                            Your active roster is{' '}
                            <Text style={{ fontWeight: fontWeight.bold }}>{trimOverflow.excess} over</Text>
                            {' '}the limit. Drop {countLabel(trimOverflow.excess, 'player')} before setting lineups or adding players.
                        </Text>
                    ) : (
                        <Text style={styles.overflowBody} accessibilityLiveRegion="polite">
                            Roster settings are loading. Drop choices return once the league limit is known.
                        </Text>
                    )}
                    <Button variant="secondary" title="Back to League" accessibilityLabel="Back to League"
                        disabled={!!trimmingId} onPress={() => navigateBackToDraftList()} />
                    {trimOverflow ? <Text style={styles.overflowDropLabel}>Select a player to drop:</Text> : null}
                    <View>
                        {trimOverflow?.dropList.map((rp) => (
                            <MotionPressable
                                key={rp.id}
                                accessibilityRole="button"
                                accessibilityLabel={`Drop ${rp.players?.display_name ?? 'Player'}`}
                                style={styles.overflowDropRow}
                                onPress={() => handleTrimDrop(rp.id)}
                                disabled={!!trimmingId || !actionsReady}
                            >
                                <PlayerRowContent name={rp.players?.display_name ?? 'Player'} nbaId={rp.players?.nba_id} team={rp.players?.nba_team}
                                            positions={rp.players?.position ? [rp.players.position] : []}
                                            birthdate={rp.players?.birthdate} yearsExp={rp.players?.years_exp} careerGames={rp.players?.career_regular_season_games} injuryStatus={rp.players?.injury_status} />
                            </MotionPressable>
                        ))}
                    </View>
                </View>
            </Sheet>

            <RookieSelectionSheet
                selection={selection}
                limits={limits}
                nextPick={nextPick}
                memberId={memberId}
                picking={picking}
                actionsReady={actionsReady}
                onDestination={chooseSelectionDestination}
                onToggleDrop={toggleSelectionDrop}
                onCancel={cancelSelection}
                onConfirm={() => { void confirmSelection() }}
            />

            <ScreenFrame style={styles.container} edges={['bottom']}>
                <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList()}>
                    {isCommissioner && !isDone && isDesktop ? (
                        <DraftAdminBar
                            disabled={adminBusy || !actionsReady}
                            inline
                            showLabel={false}
                            isPaused={isPaused}
                            showPause={canUsePauseControl}
                            onPause={handlePauseDraft}
                            onResume={handleResumeDraft}
                            onReset={handleResetDraft}
                            onStop={handleStopDraft}
                        />
                    ) : null}
                </DraftScreenHeader>
                {loadError ? <ErrorBanner message="Draft updates are unavailable. Tap to retry." onRetry={() => { void refresh() }} /> : null}
                {!draft.isMock && !isDone && canCommissionerPick ? (
                    <SettingsRow
                        label="Draft to taxi"
                        detail="Players cannot return to your taxi after leaving it."
                        role="switch"
                        checked={draftToTaxi}
                        disabled={picking || !actionsReady}
                        accessibilityLabel="Draft this pick directly into taxi"
                        onPress={() => setDraftToTaxi(!draftToTaxi)}
                        accessory={<SettingsToggle on={draftToTaxi} />}
                    />
                ) : null}
                <KeyboardAvoidingView
                    style={[styles.body, isDesktop && styles.bodyDesktop]}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
                    <View style={[styles.topDraftPanel, compactLandscape && styles.topDraftPanelCompact]}>
                        <View
                            style={[
                                styles.banner,
                                compactLandscape && styles.bannerCompact,
                                isDone && styles.bannerDone,
                                isPaused && styles.bannerPaused,
                            ]}
                        >
                            {isDone ? (
                                <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                    {stopped ? (draft.isMock ? 'Mock Draft Stopped' : 'Draft Stopped') : draft.isMock ? 'Mock Draft Complete' : 'Draft Complete'}
                                </Text>
                            ) : isPending ? (
                                <>
                                    <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                        Waiting to Start
                                    </Text>
                                    <Text style={styles.bannerSub} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {draft.isMock
                                            ? 'Picks unlock when the room creator starts the draft.'
                                            : 'Picks unlock when the commissioner starts the draft.'}
                                    </Text>
                                </>
                            ) : isPaused ? (
                                <>
                                    <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {canCommissionerPick ? 'Commissioner Pick Needed' : 'Draft Paused'}
                                    </Text>
                                    <Text style={styles.bannerSub} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {canCommissionerPick
                                            ? `Pick for ${nextPick?.teamName ?? 'the team on the clock'} to resume the draft.`
                                            : 'Commissioner will resume the pick clock.'}
                                    </Text>
                                </>
                            ) : (
                                <>
                                    <View style={styles.bannerRow}>
                                        <Text style={styles.bannerTitle} numberOfLines={1}>
                                            Round {currentRound} · Pick {madePicks + 1} of {totalPicks}
                                        </Text>
                                        {secondsLeft != null && (
                                            <Text style={[
                                                styles.bannerClock,
                                                secondsLeft <= 10 && styles.bannerClockUrgent,
                                            ]} numberOfLines={1}>
                                                {secondsLeft}s
                                            </Text>
                                        )}
                                    </View>
                                    {nextPick && (
                                        <Text style={styles.bannerSub} numberOfLines={1}>
                                            On the clock:{' '}
                                            <Text style={[styles.bannerSub, isMyTurn && styles.bannerMe]}>
                                                {nextPick.teamName}
                                                {isMyTurn ? ' (you)' : ''}
                                            </Text>
                                        </Text>
                                    )}
                                    {upNext ? (
                                        <Text style={styles.bannerSub} numberOfLines={1}>
                                            Up next:{' '}
                                            <Text style={[styles.bannerSub, upNext.memberId === memberId && styles.bannerMe]}>
                                                {upNext.teamName}
                                                {upNext.memberId === memberId ? ' (you)' : ''}
                                            </Text>
                                        </Text>
                                    ) : null}
                                </>
                            )}
                        </View>

                        {isCommissioner && !isDone && !isDesktop ? (
                            <DraftAdminBar
                                disabled={adminBusy || !actionsReady}
                                isPaused={isPaused}
                                showPause={canUsePauseControl}
                                showLabel={!compactLandscape}
                                onPause={handlePauseDraft}
                                onResume={handleResumeDraft}
                                onReset={handleResetDraft}
                                onStop={handleStopDraft}
                                style={compactLandscape ? styles.adminBarCompact : styles.adminBarWide}
                            />
                        ) : null}
                    </View>

                    {selectionOutcome ? <SelectionOutcomeBanner outcome={selectionOutcome} /> : null}
                    {completionError ? <ErrorBanner
                        message={`Could not finish the roster check. ${completionError} Tap to retry.`}
                        onRetry={() => { void refresh() }} /> : null}
                    <View style={styles.tabs}>
                        <MotionPressable
                            style={[styles.tab, activeTab === 'prospects' && styles.tabActive]}
                            onPress={() => setActiveTab('prospects')}
                            accessibilityRole="button"
                            accessibilityLabel="Show prospects"
                        >
                            <Text style={[styles.tabText, activeTab === 'prospects' && styles.tabTextActive]}>
                                Prospects
                            </Text>
                        </MotionPressable>
                        <MotionPressable
                            style={[styles.tab, activeTab === 'board' && styles.tabActive]}
                            onPress={() => setActiveTab('board')}
                            accessibilityRole="button"
                            accessibilityLabel="Show pick board"
                        >
                            <Text style={[styles.tabText, activeTab === 'board' && styles.tabTextActive]}>
                                Pick Board
                            </Text>
                        </MotionPressable>
                    </View>

                    {activeTab === 'prospects' ? (
                        <>
                            <View style={[styles.searchContainer, compactLandscape && styles.searchContainerCompact]}>
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search prospects…"
                                    placeholderTextColor={colors.inputPlaceholder}
                                    value={query}
                                    onChangeText={setQuery}
                                    autoCorrect={false}
                                    returnKeyType="search"
                                    accessibilityLabel="Search prospects"
                                />
                            </View>

                            {pickError && (
                                <View style={styles.pickErrorBanner}>
                                    <Text style={styles.pickErrorText}>{pickError}</Text>
                                </View>
                            )}

                            {prospectsLoadError ? <ErrorBanner message="Could not load prospects. Tap to retry." onRetry={() => { void refresh() }} /> : null}
                            {classNotice && !prospectsLoadError ? (
                                <View style={[styles.classNotice, classNotice.tone === 'warning' && styles.classNoticeWarning]}>
                                    <Text style={styles.classNoticeTitle}>{classNotice.title}</Text>
                                    <Text style={styles.classNoticeBody}>{classNotice.body}</Text>
                                </View>
                            ) : null}
                            <FlashList
                                data={prospects}
                                keyExtractor={(p) => p.id}
                                ItemSeparatorComponent={ItemSeparator}
                                ListEmptyComponent={
                                    !prospectsLoading && !prospectsLoadError ? (
                                        <View style={styles.emptyProspects}>
                                            <Text style={styles.emptyText}>
                                                {query.trim() ? 'No matching prospects' : classNotice?.empty ?? 'No prospects available'}
                                            </Text>
                                        </View>
                                    ) : null
                                }
                                renderItem={({ item }) => (
                                    <ProspectRow
                                        player={item}
                                        canPick={!isDone && !isPending && !pickTimerExpired && (!isPaused || canCommissionerPick)
                                            && (isMyTurn || canCommissionerPick)}
                                        picking={picking || !actionsReady}
                                        onPick={canCommissionerPick ? handleCommissionerPick : choosesPlacement ? beginSelection : handlePick}
                                        actionLabel={canCommissionerPick ? 'Commish Pick' : choosesPlacement ? 'Select' : 'Pick'}
                                    />
                                )}
                            />
                        </>
                    ) : (
                        <FlashList
                            data={picks}
                            keyExtractor={(p) => String(p.overallPick)}
                            ItemSeparatorComponent={ItemSeparator}
                            ListHeaderComponent={PickBoardHeader}
                            renderItem={({ item }) => (
                                <RookiePickRow item={item} myMemberId={memberId} nextPick={nextPick} />
                            )}
                        />
                    )}
                </KeyboardAvoidingView>
            </ScreenFrame>
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

function ProspectRow({
    player,
    canPick,
    picking,
    onPick,
    actionLabel = 'Pick',
}: {
    player: RookieProspect
    canPick: boolean
    picking: boolean
    onPick: (player: RookieProspect) => void
    actionLabel?: string
}) {
    return (
        <MotionPressable
            style={styles.resultRow}
            onPress={!canPick || picking ? undefined : () => onPick(player)}
            disabled={!canPick || picking}
            accessibilityRole={canPick ? 'button' : 'text'}
            accessibilityLabel={canPick ? `${actionLabel} ${player.display_name}` : player.display_name}
        >
            <PlayerRowContent name={player.display_name} nbaId={player.nba_id} team={player.nba_team}
                positions={player.position ? [player.position] : []} playerId={player.id} yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status}
                stats={prospectDraftLabel(player)} />
            {canPick && (
                <Text style={styles.pickBtn} numberOfLines={1}>{actionLabel}</Text>
            )}
        </MotionPressable>
    )
}



function prospectDraftLabel(player: RookieProspect): string | undefined {
    const overall = player.draft_overall_pick ?? player.nba_draft_number
    if (overall == null) return undefined
    return player.draft_round != null ? `NBA draft #${overall} · Rd ${player.draft_round}` : `NBA draft #${overall}`
}

type ClassNotice = { title: string; body: string; empty: string; tone: 'info' | 'warning' }

function rookieClassNotice(status: RookieClassStatus | null, classYear: number | null): ClassNotice | null {
    if (!status) return null
    const year = classYear ?? status.draftYear
    if (status.state === 'failed') {
        return {
            tone: 'warning',
            title: `The ${year} NBA draft class could not be loaded`,
            body: status.eligibleCount > 0
                ? `The official board did not load, so it cannot be checked. Players with a confirmed ${year} draft selection are still listed.`
                : 'The official board did not load. Prospects appear once the next import succeeds.',
            empty: 'The draft class is not available yet',
        }
    }
    if (status.state === 'not_imported') {
        return status.eligibleCount > 0 ? null : {
            tone: 'info',
            title: `The ${year} NBA draft class is not imported yet`,
            body: `Only players selected in the ${year} NBA draft can be picked. They appear here once the class loads.`,
            empty: 'The draft class is not available yet',
        }
    }
    if (status.state === 'incomplete') {
        return {
            tone: 'warning',
            title: `${status.eligibleCount} of ${status.officialCount} draftees confirmed`,
            body: `Some ${year} NBA draft selections are still being matched to players. Unmatched players cannot be picked yet.`,
            empty: 'Every confirmed draftee has been taken',
        }
    }
    if (status.availableCount === 0 && status.eligibleCount > 0) {
        return {
            tone: 'info',
            title: `Every ${year} draftee has been taken`,
            body: 'No eligible players remain in this class.',
            empty: 'Every draftee has been taken',
        }
    }
    return null
}

const DESTINATION_COPY: Record<RookieDestination, string> = {
    active: 'Joins your active roster.',
    taxi: 'Starts on your taxi squad. Players cannot return to taxi after leaving it.',
    drop: 'Released to waivers right away. The pick is still used.',
}

function RookieSelectionSheet({
    selection,
    limits,
    nextPick,
    memberId,
    picking,
    actionsReady,
    onDestination,
    onToggleDrop,
    onCancel,
    onConfirm,
}: {
    selection: RookieSelection | null
    limits: RosterLimits | null
    nextPick: SnakePick | null
    memberId?: string
    picking: boolean
    actionsReady: boolean
    onDestination: (destination: RookieDestination) => void
    onToggleDrop: (rosterPlayerId: string) => void
    onCancel: () => void
    onConfirm: () => void
}) {
    const player = selection?.player
    const roster = selection?.roster ?? null
    const plan = selection && roster && limits ? planRookiePlacement(roster, limits, selection.destination, selection.dropIds) : null
    const stale = !!selection && (nextPick?.overallPick !== selection.expectedOverallPick || nextPick?.memberId !== memberId)
    const taxiOpen = !!player?.taxi_eligible && (limits?.taxiSlots ?? 0) > 0
    const options: { label: string; value: RookieDestination }[] = [
        { label: 'Active', value: 'active' },
        ...(taxiOpen ? [{ label: 'Taxi', value: 'taxi' as const }] : []),
        { label: 'Drop rookie', value: 'drop' },
    ]
    const dropList: RosterPlayer[] = plan?.dropChoices && roster ? partitionRoster(roster)[plan.dropChoices] : []
    const droppedNames = roster?.filter(row => selection?.dropIds.includes(row.id)).map(row => row.players?.display_name ?? 'Player') ?? []
    const canConfirm = !!plan?.valid && !stale && actionsReady && !picking
    return (
        <Sheet visible={!!selection} title={player ? `Draft ${player.display_name}` : 'Draft'} onClose={() => { if (!picking) onCancel() }}>
            {selection && player ? (
                <View style={styles.overflowCard}>
                    <Text style={styles.overflowBody}>
                        Pick {selection.expectedOverallPick}{prospectDraftLabel(player) ? ` · ${prospectDraftLabel(player)}` : ''}
                    </Text>
                    <SegmentedControl
                        options={options}
                        value={selection.destination}
                        onChange={onDestination}
                        accessibilityLabel="Where the rookie goes"
                        equalWidth
                    />
                    <Text style={styles.overflowBody}>{DESTINATION_COPY[selection.destination]}</Text>
                    {selection.rosterError ? <Text style={styles.pickErrorText}>Could not load your roster. {selection.rosterError} Cancel and try again.</Text> : null}
                    {!roster && !selection.rosterError ? <LoadingState /> : null}
                    {!limits && roster ? <Text style={styles.overflowBody}>Roster settings are loading.</Text> : null}
                    {plan?.dropChoices ? (
                        <>
                            <Text style={styles.overflowDropLabel}>
                                {plan.dropChoices === 'active' ? 'Your active roster is full. Choose who to drop:' : 'Your taxi squad is full. Choose who to drop:'}
                            </Text>
                            <View>
                                {dropList.map(row => {
                                    const chosen = selection.dropIds.includes(row.id)
                                    return (
                                        <MotionPressable
                                            key={row.id}
                                            role="checkbox"
                                            aria-checked={chosen}
                                            accessibilityRole="checkbox"
                                            accessibilityState={{ checked: chosen, disabled: picking }}
                                            accessibilityLabel={`Drop ${row.players?.display_name ?? 'Player'}`}
                                            style={[styles.overflowDropRow, chosen && styles.dropRowChosen]}
                                            onPress={() => onToggleDrop(row.id)}
                                            disabled={picking}
                                        >
                                            <PlayerRowContent name={row.players?.display_name ?? 'Player'} nbaId={row.players?.nba_id} team={row.players?.nba_team}
                                                positions={row.players?.position ? [row.players.position] : []}
                                                birthdate={row.players?.birthdate} yearsExp={row.players?.years_exp} careerGames={row.players?.career_regular_season_games} injuryStatus={row.players?.injury_status} />
                                            <Text style={[styles.dropMark, chosen && styles.dropMarkChosen]}>{chosen ? 'Dropping' : 'Drop'}</Text>
                                        </MotionPressable>
                                    )
                                })}
                            </View>
                        </>
                    ) : null}
                    {plan && limits ? (
                        <View style={styles.preview} accessibilityLiveRegion="polite">
                            <Text style={styles.previewTitle}>After this pick</Text>
                            <Text style={[styles.previewLine, plan.activeOver > 0 && styles.previewOver]}>
                                Active roster {plan.activeAfter} of {limits.rosterSize}{plan.activeOver > 0 ? ` · ${plan.activeOver} over` : ''}
                            </Text>
                            <Text style={[styles.previewLine, plan.taxiOver > 0 && styles.previewOver]}>
                                Taxi {plan.taxiAfter} of {limits.taxiSlots}{plan.taxiOver > 0 ? ` · ${plan.taxiOver} over` : ''}
                            </Text>
                            {droppedNames.length > 0 ? <Text style={styles.previewLine}>Dropping {droppedNames.join(', ')}</Text> : null}
                            {selection.destination === 'drop' ? <Text style={styles.previewLine}>{player.display_name} goes to waivers</Text> : null}
                        </View>
                    ) : null}
                    {stale ? <Text style={styles.pickErrorText}>This pick is no longer yours to make. Cancel and check the board.</Text> : null}
                    {selection.error ? <Text style={styles.pickErrorText} accessibilityLiveRegion="assertive">{selection.error}</Text> : null}
                    <View style={styles.sheetActions}>
                        <Button variant="secondary" title="Cancel" accessibilityLabel="Cancel this pick" disabled={picking} onPress={onCancel} style={styles.sheetAction} />
                        <Button title={picking ? 'Drafting…' : 'Confirm pick'} accessibilityLabel={`Confirm drafting ${player.display_name}`}
                            disabled={!canConfirm} onPress={onConfirm} style={styles.sheetAction} />
                    </View>
                </View>
            ) : null}
        </Sheet>
    )
}

function SelectionOutcomeBanner({ outcome }: { outcome: RookieSelectionOutcome }) {
    const where = outcome.destination === 'taxi' ? 'Added to your taxi squad.'
        : outcome.destination === 'drop' ? 'Released to waivers. The pick is used.' : 'Added to your active roster.'
    return (
        <View style={styles.outcome} accessibilityLiveRegion="polite">
            <Text style={styles.outcomeTitle}>You drafted {outcome.playerName} with pick {outcome.overallPick}</Text>
            <Text style={styles.outcomeBody}>
                {where}{outcome.droppedNames.length > 0 ? ` Dropped ${outcome.droppedNames.join(', ')}.` : ''}
            </Text>
        </View>
    )
}

const ItemSeparator = () => <View style={styles.separator} />

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    body: { flex: 1, marginHorizontal: spacing.lg, marginBottom: spacing.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.xl, overflow: 'hidden' },
    bodyDesktop: {
        width: '100%',
        maxWidth: layout.formMaxWidth,
        alignSelf: 'center',
        marginHorizontal: spacing.none,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { ...textStyles.body, color: colors.textPlaceholder },

    topDraftPanel: {},
    topDraftPanelCompact: {
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'stretch',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },

    banner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: uiColors.brandBorderSoft,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.xs,
    },
    bannerCompact: {
        flex: 1,
        minWidth: 0,
        minHeight: 54,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderBottomWidth: 0,
    },
    bannerDone: { backgroundColor: uiColors.successSurface, borderBottomColor: uiColors.successBorder },
    bannerPaused: { backgroundColor: colors.bgSubtle, borderBottomColor: colors.border },
    adminBarWide: { paddingHorizontal: spacing.xl },
    adminBarCompact: {
        width: 252,
        minHeight: 54,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderBottomWidth: 0,
        borderLeftWidth: 1,
        borderLeftColor: colors.borderLight,
    },
    bannerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    bannerTitle: { ...typeScale.title, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    bannerClock: { ...typeScale.title, flexShrink: 0, fontWeight: fontWeight.extrabold, color: colors.textMuted, width: table.statColWidth, textAlign: 'right', fontVariant: ['tabular-nums'] },
    bannerClockUrgent: { color: colors.dangerDark },
    bannerSub: { ...typeScale.body, color: colors.textSecondary },
    bannerMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    tabs: { flexDirection: 'row', gap: spacing.xs },
    tab: {
        borderRadius: radii.md,
        flex: 1,
        minHeight: controlSize.minTouch,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: { backgroundColor: colors.primaryLight },
    tabText: { ...typeScale.row, fontWeight: fontWeight.semibold, color: colors.textMuted },
    tabTextActive: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: spacing.lg,
        marginBottom: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.bgInput,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
    },
    searchContainerCompact: {
        minHeight: controlSize.minTouch,
        marginHorizontal: spacing.xs,
        marginTop: spacing.xxs,
        marginBottom: spacing.none,
        paddingVertical: spacing.none,
        borderRadius: radii.md,
    },
    searchInput: { flex: 1, height: controlSize.field.md, fontSize: controlSize.field.fontSize, color: colors.textPrimary },

    emptyProspects: { paddingVertical: spacing['5xl'], alignItems: 'center' },
    pickErrorBanner: {
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        padding: spacing.md,
        backgroundColor: uiColors.dangerSurface,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: uiColors.dangerBorder,
    },
    pickErrorText: { ...typeScale.small, color: colors.dangerDark, fontWeight: fontWeight.semibold },

    resultRow: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        gap: spacing.md,
    },
    resultInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    resultNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    resultName: { ...textStyles.rowTitle, flexShrink: 1 },
    resultTeam: { ...textStyles.meta },
    pickBtn: { ...typeScale.row, flexShrink: 0, fontWeight: fontWeight.bold, color: colors.primaryDark },


    separator: { height: 1, backgroundColor: colors.separator },

    pickHeader: { paddingHorizontal: spacing.xl, gap: spacing.md },
    headerText: { ...textStyles.tableHeader },













    pickedName: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    pickedTeam: { ...typeScale.caption, color: colors.textMuted },
    overflowCard: { gap: spacing.md },
    overflowBody: {
        ...typeScale.body,
        color: colors.textSecondary,
    },
    overflowDropLabel: {
        ...typeScale.small,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
        marginTop: spacing.md,
    },
    overflowDropRow: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    overflowDropInfo: { flex: 1, minWidth: 0 },
    dropRowChosen: { backgroundColor: uiColors.dangerSurface },
    dropMark: { ...typeScale.row, flexShrink: 0, fontWeight: fontWeight.bold, color: colors.textMuted },
    dropMarkChosen: { color: colors.dangerDark },
    preview: {
        gap: spacing.xxs,
        padding: spacing.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    previewTitle: { ...textStyles.sectionLabel },
    previewLine: { ...typeScale.small, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
    previewOver: { color: colors.dangerDark, fontWeight: fontWeight.semibold },
    sheetActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
    sheetAction: { flex: 1 },
    outcome: {
        marginHorizontal: spacing.lg,
        marginTop: spacing.md,
        padding: spacing.md,
        gap: spacing.xxs,
        backgroundColor: uiColors.successSurface,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: uiColors.successBorder,
    },
    outcomeTitle: { ...typeScale.row, fontWeight: fontWeight.bold, color: colors.textPrimary },
    outcomeBody: { ...typeScale.small, color: colors.textSecondary },
    classNotice: {
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        padding: spacing.md,
        gap: spacing.xxs,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    classNoticeWarning: { backgroundColor: uiColors.warningSurface, borderColor: uiColors.warningBorder },
    classNoticeTitle: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.textPrimary },
    classNoticeBody: { ...typeScale.small, color: colors.textSecondary },
    overflowDropName: {
        ...typeScale.row,
        fontWeight: fontWeight.semibold,
        color: uiColors.dangerText,
    },
    overflowDropPos: {
        ...typeScale.caption,
        color: colors.textMuted,
    },
})

const PickBoardHeader = (
    <ListHeader style={styles.pickHeader}>
        <Text style={[rookiePickRowStyles.pickNum, styles.headerText]}>#</Text>
        <Text style={[rookiePickRowStyles.pickTeam, styles.headerText]}>Team</Text>
        <Text style={[rookiePickRowStyles.pickPlayer, styles.headerText]}>Player</Text>
    </ListHeader>
)
