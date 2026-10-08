import {
    Platform,
    View,
    Text,
    Pressable,
    StyleSheet,
    ScrollView,
    useWindowDimensions,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
import { useRouter } from 'expo-router'
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner, Page, usePageMetrics } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { Scoreboard } from '@/components/Scoreboard'
import { getLineupMoveTargetState, LineupSlot, LineupPlayer, type LineupMoveTargetState } from '@/lib/lineup'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { LiveStatLine } from '@/lib/games'
import { breakpoints, colors, fontSize, fontWeight, layout, radii, spacing, srOnly, textStyles } from '@/constants/tokens'
import { DaySelector } from '@/components/DaySelector'
import { ScoreCard } from '@/components/ScoreCard'
import { NoLeagueState } from '@/components/NoLeagueState'
import { AutoSetModal } from '@/components/AutoSetModal'
import { MatchupColumnHeader, MatchupRow, statLineupWidth } from '@/components/MatchupRow'
import { ScoreBreakdownSheet } from '@/components/ScoreBreakdownSheet'
import { lineupStatColumns, type StatColumn } from '@/lib/score-breakdown'
import { LeagueSwitcher } from '@/components/LeagueSwitcher'
import { ActivationOverflowModal } from '@/components/ActivationOverflowModal'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { resolveHomeSurface } from '@/lib/home-surface'
import { useLiveStats } from '@/hooks/use-live-stats'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { countLabel, formatPoints, shortName } from '@/lib/format'
import { todayET } from '@/lib/shared/dates'
import { MotionPressable, MotionView } from '@/components/Motion'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

function shouldShowScoreboard(selectedDate: string, today: string): boolean {
    return selectedDate === today
}

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type DetailsRow = { myPlayer: LineupPlayer | null; oppPlayer: LineupPlayer | null; slotType: string }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number } | { kind: 'taxi'; index: number }

// Mirrors the loaded lineup chrome exactly (header, AUTO control, day
// selector) so nothing moves when rows hydrate — the rows area stays blank
// rather than showing a placeholder that differs from the final UI.
function MatchupLineupLoadingState({ daySelector }: { daySelector?: ReactNode }) {
    return (
        <View
            style={styles.lineupContainer}
            role="status"
            aria-busy
            aria-label="Matchup lineup loading"
            accessibilityLabel="Matchup lineup loading"
            accessibilityState={{ busy: true }}
        >
            <LineupHeading />
            {daySelector}
        </View>
    )
}

// The section bands and AUTO control label the lineup on screen; this heading
// keeps the page outline intact for screen readers.
function LineupHeading() {
    return (
        <Text style={srOnly} role="heading" aria-level={2} accessibilityRole="header">
            Lineup
        </Text>
    )
}

export default function HomeScreen() {
    const { memberships, current, currentLeague: league, setCurrent, loading: leagueLoading } = useLeagueContext()
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const { padX, usableWidth } = usePageMetrics()
    // Short screens tighten vertical spacing; only narrow screens shorten names.
    const narrow = width < breakpoints.phone
    const compact = narrow || height < 840
    const dense = height < 620
    const { openDraftRoom } = useDraftRoomLauncher(league?.id, { notifyOnError: true })

    const {
        matchup, leagueMatchups, weekDays, selectedDate, setSelectedDate,
        myLineup, oppLineup, matchupLoading, lineupLoading,
        loadMyLineup, loadLineups, refreshSilently, matchupRef,
        error, refresh,
    } = useMatchupData(current, user, league)
    const homeSurface = resolveHomeSurface({ leagueStatus: league?.status, hasMatchup: Boolean(matchup), loading: matchupLoading, error })

    const { todaysGames, liveStats, startedTeams, liveTeams, teamMatchups } = useLiveStats(selectedDate, refreshSilently)
    const actionContext = useMemo(() => matchup && league ? {
        memberId: matchup.myMemberId,
        leagueId: league.id,
        seasonId: matchup.seasonId,
        weekNumber: matchup.weekNumber,
        seasonYear: matchup.seasonYear,
    } : null, [matchup, league])
    const reloadLineupForActions = useCallback(async (date: string) => {
        if (!matchup) return
        await loadMyLineup(matchup, date)
    }, [matchup, loadMyLineup])

    const {
        selected, setSelected, saving, autoSetting,
        autoSetModalVisible, setAutoSetModalVisible,
        activationOverflowPending, setActivationOverflowPending, activationOverflowSaving,
        handleTap, handleOverflowDrop, handleOverflowMoveToIR, handleOverflowMoveToTaxi,
        doAutoSet, handleAutoSet,
    } = useLineupActions({ actionContext, myLineup, league, selectedDate, startedTeams, reloadLineup: reloadLineupForActions })

    // Clear selection whenever lineup reloads (tab focus / league change)
    useEffect(() => {
        if (matchupLoading) setSelected(null)
    }, [matchupLoading, setSelected])

    const handleDaySelect = useCallback(
        async (date: string) => {
            if (!matchupRef.current) return
            setSelectedDate(date)
            setSelected(null)
            await loadLineups(matchupRef.current, date)
        },
        [matchupRef, setSelectedDate, setSelected, loadLineups],
    )

    const todayPlayingTeams = useMemo(
        () => new Set(weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? []),
        [weekDays, selectedDate],
    )

    const myTeamSet = useMemo(
        () =>
            new Set<string>(
                myLineup
                    ? ([
                          ...(myLineup.starters ?? []).map((s) => s.player?.nbaTeam),
                          ...(myLineup.bench ?? []).map((p) => p.nbaTeam),
                          ...(myLineup.ir ?? []).map((p) => p.nbaTeam),
                          ...(myLineup.taxi ?? []).map((p) => p.nbaTeam),
                      ].filter(Boolean) as string[])
                    : [],
            ),
        [myLineup],
    )

    const selectedPlayer = useMemo(() => {
        if (!myLineup || !selected) return null
        return selected.kind === 'starter'
            ? myLineup.starters[selected.index]?.player
            : selected.kind === 'bench'
              ? myLineup.bench[selected.index]
              : selected.kind === 'ir'
                ? myLineup.ir[selected.index]
                : myLineup.taxi[selected.index]
    }, [myLineup, selected])

    const getTargetState = useCallback((to: Sel): LineupMoveTargetState =>
        myLineup && league
            ? getLineupMoveTargetState({
                  lineup: myLineup,
                  league,
                  startedTeams,
                  from: selected,
                  to,
              })
            : null,
    [league, myLineup, selected, startedTeams])

    const scoringSettings = useMemo(
        () =>
            league?.scoring_settings &&
            typeof league.scoring_settings === 'object' &&
            !Array.isArray(league.scoring_settings)
                ? (league.scoring_settings as Record<string, number>)
                : {},
        [league?.scoring_settings],
    )

    // Wide screens show a box score per row; the side column only joins when
    // the lineup still fits next to it.
    const statColumns = useMemo(() => lineupStatColumns(scoringSettings), [scoringSettings])
    const showStatColumns = !narrow && usableWidth >= statLineupWidth(statColumns)
    const lineupWidth = showStatColumns ? statLineupWidth(statColumns) : layout.lineupMaxWidth
    const twoPane = !narrow && usableWidth >= lineupWidth + spacing['3xl'] + layout.railWidth

    const [detailsRow, setDetailsRow] = useState<DetailsRow | null>(null)

    const today = todayET()

    // Stay blank while auth/league context loads — flashing the NoLeagueState
    // welcome (or any placeholder) and then swapping it for the real screen is
    // exactly the layout jump this screen must avoid.
    if (authLoading || (leagueLoading && memberships.length === 0)) {
        return <View style={styles.blank} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0) return <NoLeagueState />

    const sideInfo = (
        <>
            <AroundLeague matchups={leagueMatchups} compact={narrow} stacked={twoPane} />
            {shouldShowScoreboard(selectedDate, today) && !dense ? (
                <View style={styles.scoreboardFooter}>
                    <Scoreboard games={todaysGames} myTeamSet={myTeamSet} compact={compact} wrap={twoPane} />
                </View>
            ) : null}
        </>
    )

    return (
        <Page title="Matchup" width="full">
            {Platform.OS !== 'web' && (
                // The web shell's header has its own league switcher; this row
                // would duplicate it. Native has no shell header, so it stays.
                <LeagueSwitcher
                    memberships={memberships}
                    currentId={current?.id}
                    onSelect={(membership) => {
                        const fullMembership = memberships.find((m) => m.id === membership.id)
                        if (fullMembership) setCurrent(fullMembership)
                    }}
                    compact={compact}
                />
            )}

            {/* The error card owns the retry when there is no matchup to show; the banner covers a failed refresh over live data. */}
            {error && homeSurface !== 'error' && <ErrorBanner onRetry={refresh} />}

            {matchup ? (
                <View style={[styles.playSurface, twoPane && styles.playSurfaceTwoPane, { paddingHorizontal: padX }]}>
                    <View style={[styles.mainColumn, { maxWidth: lineupWidth }, twoPane && styles.mainColumnTwoPane]}>
                    <ScoreCard matchup={matchup} compact={compact} />

                    {myLineup && oppLineup ? (
                        <MatchupLineupView
                            myLineup={myLineup}
                            oppLineup={oppLineup}
                            selected={selected}
                            getTargetState={getTargetState}
                            onTap={handleTap}
                            saving={saving}
                            playingTeams={todayPlayingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            scoringSettings={scoringSettings}
                            teamMatchups={teamMatchups}
                            statColumns={showStatColumns ? statColumns : null}
                            onOpenDetails={setDetailsRow}
                            capacity={{
                                bench: Math.max(0, (league?.roster_size ?? 20) - myLineup.starters.length),
                                ir: league?.ir_slots ?? 2,
                                taxi: league?.taxi_slots ?? 3,
                            }}
                            compact={narrow}
                            dense={dense}
                            daySelector={weekDays.length > 0 ? (
                                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                            ) : null}
                            autoSetControl={
                                <MotionPressable
                                    style={styles.autoSetBtn}
                                    hitSlop={{ top: 9, bottom: 9, left: 8, right: 8 }}
                                    onPress={handleAutoSet}
                                    disabled={autoSetting || saving}
                                    accessibilityRole="button"
                                    accessibilityLabel="Open auto-set lineup options"
                                    accessibilityState={{ disabled: autoSetting || saving }}
                                    pressedScale={0.92}
                                >
                                    <Text style={styles.autoSetText}>AUTO</Text>
                                </MotionPressable>
                            }
                            hint={selected ? (
                                <MotionView style={styles.hint} preset="slide-left">
                                    <Text style={styles.hintText} numberOfLines={1}>
                                        {selectedPlayer
                                            ? `${shortName(selectedPlayer.displayName)} selected — tap another slot`
                                            : `Empty slot selected — tap a player's slot`}
                                    </Text>
                                    <MotionPressable onPress={() => setSelected(null)} pressedScale={0.9}>
                                        <Text style={styles.hintCancel}>Cancel</Text>
                                    </MotionPressable>
                                </MotionView>
                            ) : null}
                            footer={twoPane ? null : sideInfo}
                        />
                    ) : matchupLoading || lineupLoading ? (
                        <MatchupLineupLoadingState
                            daySelector={weekDays.length > 0 ? (
                                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                            ) : null}
                        />
                    ) : (
                        <>
                            {weekDays.length > 0 && (
                                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                            )}
                            <View style={styles.noLineup}>
                                <Text style={styles.noLineupText}>No lineup set for this day.</Text>
                                <Pressable style={styles.setLineupBtn} onPress={handleAutoSet} disabled={autoSetting}>
                                    <Text style={styles.setLineupBtnText}>Auto-Set Lineup</Text>
                                </Pressable>
                            </View>
                        </>
                    )}
                    </View>
                    {twoPane ? (
                        <ScrollView
                            style={styles.rail}
                            contentContainerStyle={styles.railContent}
                            showsVerticalScrollIndicator={false}
                        >
                            {sideInfo}
                        </ScrollView>
                    ) : null}
                </View>
            ) : homeSurface === 'draft' ? (
                <View style={styles.playSurface}>
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="flash-on"
                        message="Your draft is live"
                        description="The auction draft is underway — nominate players and build your roster before the season tips off."
                        actionLabel="Go to Draft Room"
                        onAction={() => { void openDraftRoom() }}
                    />
                </View>
            ) : homeSurface === 'loading' ? (
                <View style={styles.playSurface} />
            ) : homeSurface === 'error' ? (
                // A failed load is not an empty week: never tell the manager no
                // matchup exists when the request simply failed (offline, cold cache).
                <View style={styles.playSurface}>
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="cloud-off"
                        message="Couldn't load your matchup"
                        description="Check your connection and try again. Nothing here is stale data."
                        actionLabel="Retry"
                        onAction={refresh}
                    />
                </View>
            ) : (
                <View style={styles.playSurface}>
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="event"
                        message="No matchup this week yet"
                        description="Matchups post before each week starts. Until then, scout the player pool and get your roster ready."
                        actionLabel="Browse Players"
                        onAction={() => router.push('/players')}
                    />
                </View>
            )}

            <ActivationOverflowModal
                pending={activationOverflowPending}
                myLineup={myLineup}
                leagueTaxiSlots={league?.taxi_slots ?? 0}
                saving={activationOverflowSaving}
                onDrop={handleOverflowDrop}
                onMoveToIR={handleOverflowMoveToIR}
                onMoveToTaxi={handleOverflowMoveToTaxi}
                onCancel={() => setActivationOverflowPending(null)}
            />

            <ScoreBreakdownSheet
                visible={detailsRow != null}
                onClose={() => setDetailsRow(null)}
                slotType={detailsRow?.slotType ?? ''}
                mine={{ player: detailsRow?.myPlayer ?? null, stats: detailsRow?.myPlayer ? liveStats.get(detailsRow.myPlayer.playerId) : undefined }}
                theirs={{ player: detailsRow?.oppPlayer ?? null, stats: detailsRow?.oppPlayer ? liveStats.get(detailsRow.oppPlayer.playerId) : undefined }}
                settings={scoringSettings}
            />

            <AutoSetModal
                visible={autoSetModalVisible}
                onClose={() => setAutoSetModalVisible(false)}
                onToday={() => { setAutoSetModalVisible(false); doAutoSet(selectedDate) }}
                onWholeWeek={() => { setAutoSetModalVisible(false); doAutoSet(null) }}
                onRestOfSeason={() => { setAutoSetModalVisible(false); doAutoSet(null, true) }}
            />
        </Page>
    )
}

function AroundLeague({ matchups, compact, stacked = false }: { matchups: LeagueWeekMatchup[]; compact: boolean; stacked?: boolean }) {
    const { width } = useWindowDimensions()
    const otherMatchups = matchups.filter((item) => !item.isMine)
    if (otherMatchups.length === 0) return null
    const cards = otherMatchups.map((item) => (
        <AroundLeagueCard
            key={item.id}
            item={item}
            style={stacked ? undefined : compact ? [styles.aroundLeagueCardCompact, { width: Math.min(220, width - 82) }] : styles.aroundLeagueCardFixed}
        />
    ))

    const cardGap = compact ? spacing.sm : spacing.md
    const cardWidth = Math.min(220, width - 82)

    return (
        <View style={styles.aroundLeague}>
            <View style={styles.aroundLeagueHeader}>
                <Text
                    style={styles.aroundLeagueTitle}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                >
                    Other matchups
                </Text>
                <Text style={styles.aroundLeagueMeta}>{countLabel(otherMatchups.length, 'matchup')}</Text>
            </View>
            {stacked ? (
                <View style={styles.aroundLeagueStack}>{cards}</View>
            ) : (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    // On narrow screens one card fits fully with a peek of the next
                    // card's name edge, so a score never sits under the clip.
                    snapToInterval={compact ? cardWidth + cardGap : undefined}
                    decelerationRate={compact ? 'fast' : undefined}
                    contentContainerStyle={[styles.aroundLeagueScroll, { gap: cardGap }]}
                >
                    {cards}
                </ScrollView>
            )}
        </View>
    )
}

function AroundLeagueCard({ item, style }: { item: LeagueWeekMatchup; style?: StyleProp<ViewStyle> }) {
    const homeScore = item.homePoints
    const awayScore = item.awayPoints
    const homeLeading = homeScore != null && (awayScore == null || homeScore >= awayScore)
    const awayLeading = awayScore != null && (homeScore == null || awayScore > homeScore)
    return (
        <View style={[styles.aroundLeagueCard, style]}>
            <View style={styles.aroundLeagueTeamRow}>
                <Text style={[styles.aroundLeagueTeam, homeLeading && styles.aroundLeagueTeamLeading]} numberOfLines={1}>
                    {item.homeTeamName}
                </Text>
                <Text style={[styles.aroundLeagueScore, homeLeading && styles.aroundLeagueScoreLeading]}>
                    {formatPoints(item.homePoints)}
                </Text>
            </View>
            <View style={styles.aroundLeagueDivider} />
            <View style={styles.aroundLeagueTeamRow}>
                <Text style={[styles.aroundLeagueTeam, awayLeading && styles.aroundLeagueTeamLeading]} numberOfLines={1}>
                    {item.awayTeamName}
                </Text>
                <Text style={[styles.aroundLeagueScore, awayLeading && styles.aroundLeagueScoreLeading]}>
                    {formatPoints(item.awayPoints)}
                </Text>
            </View>
            <Text style={styles.aroundLeagueStatus}>{item.isFinalized ? 'Final' : 'Live'}</Text>
        </View>
    )
}

function MatchupLineupView({
    myLineup,
    oppLineup,
    selected,
    getTargetState,
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    statColumns,
    onOpenDetails,
    capacity,
    compact,
    dense,
    daySelector,
    autoSetControl,
    hint,
    footer,
}: {
    myLineup: LineupData
    oppLineup: LineupData
    selected: Sel | null
    getTargetState: (selection: Sel) => LineupMoveTargetState
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    statColumns: StatColumn[] | null
    onOpenDetails: (row: DetailsRow) => void
    /** League slot counts; every slot shows, filled or empty, so open room is visible. */
    capacity: { bench: number; ir: number; taxi: number }
    compact: boolean
    dense: boolean
    daySelector?: ReactNode
    autoSetControl?: ReactNode
    hint?: ReactNode
    footer?: ReactNode
}) {
    const maxBench = Math.max(myLineup.bench.length, oppLineup.bench.length, capacity.bench)
    const maxIR = Math.max(myLineup.ir.length, oppLineup.ir.length, capacity.ir)
    const maxTaxi = Math.max(myLineup.taxi.length, oppLineup.taxi.length, capacity.taxi)
    const sections = useMemo(
        () => [
            {
                key: 'starters' as const,
                label: 'Starters',
                count: myLineup.starters.length,
                used: `${myLineup.starters.filter((slot) => slot.player).length}/${myLineup.starters.length}`,
                color: colors.primaryDark,
                rows: myLineup.starters.map((slot, i) => ({
                    key: `s${i}`,
                    myPlayer: slot.player,
                    oppPlayer: oppLineup.starters[i]?.player ?? null,
                    slotType: slot.slotType,
                    selKind: 'starter' as const,
                    selIndex: i,
                    isExtraOppRow: false,
                })),
            },
            {
                key: 'bench' as const,
                label: 'Bench',
                count: maxBench,
                used: `${myLineup.bench.length}/${capacity.bench}`,
                color: colors.textMuted,
                rows: Array.from({ length: maxBench }, (_, i) => ({
                    key: `b${i}`,
                    myPlayer: myLineup.bench[i] ?? null,
                    oppPlayer: oppLineup.bench[i] ?? null,
                    slotType: 'BE',
                    selKind: 'bench' as const,
                    selIndex: i,
                    // Rows past my bench size are open slots I can move a starter into;
                    // only rows past the league's bench size belong to the opponent alone.
                    isExtraOppRow: i >= Math.max(myLineup.bench.length, capacity.bench),
                })),
            },
            {
                key: 'ir' as const,
                label: 'Injured Reserve',
                count: maxIR,
                used: `${myLineup.ir.length}/${capacity.ir}`,
                color: colors.danger,
                rows: Array.from({ length: maxIR }, (_, i) => ({
                    key: `ir${i}`,
                    myPlayer: myLineup.ir[i] ?? null,
                    oppPlayer: oppLineup.ir[i] ?? null,
                    slotType: 'IR',
                    selKind: 'ir' as const,
                    selIndex: i,
                    isExtraOppRow: false,
                })),
            },
            {
                key: 'taxi' as const,
                label: 'Taxi Squad',
                count: maxTaxi,
                used: `${myLineup.taxi.length}/${capacity.taxi}`,
                color: colors.textMuted,
                rows: Array.from({ length: maxTaxi }, (_, i) => ({
                    key: `tx${i}`,
                    myPlayer: myLineup.taxi[i] ?? null,
                    oppPlayer: oppLineup.taxi[i] ?? null,
                    slotType: 'TX',
                    selKind: 'taxi' as const,
                    selIndex: i,
                    isExtraOppRow: false,
                })),
            },
        ].filter((section) => section.key === 'starters' || section.count > 0),
        [capacity.bench, capacity.ir, capacity.taxi, maxBench, maxIR, maxTaxi, myLineup, oppLineup],
    )

    return (
        <View style={styles.lineupContainer}>
            <LineupHeading />
            {daySelector}
            {hint}

            <ScrollView
                style={styles.lineupRows}
                contentContainerStyle={styles.lineupRowsContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
            >
                {sections.map((section) => (
                    <View key={section.key} style={styles.lineupSection}>
                        <View style={[styles.lineupSectionBand, { borderLeftColor: section.color }]}>
                            <Text
                                style={[styles.lineupSectionTitle, { color: section.color }]}
                                role="heading"
                                aria-level={2}
                                accessibilityRole="header"
                            >
                                {section.label}
                            </Text>
                            {section.key === 'starters' && autoSetControl ? autoSetControl : (
                                <Text style={styles.lineupSectionCount}>{section.used}</Text>
                            )}
                        </View>
                        {statColumns ? <MatchupColumnHeader columns={statColumns} /> : null}
                        {section.rows.map((row, i) => (
                            <MatchupRow
                                key={row.key}
                                myPlayer={row.myPlayer}
                                oppPlayer={row.oppPlayer}
                                slotType={row.slotType}
                                selKind={row.selKind}
                                selIndex={row.selIndex}
                                isSelected={selected?.kind === row.selKind && selected.index === row.selIndex}
                                onTap={onTap}
                                saving={saving}
                                playingTeams={playingTeams}
                                liveStats={liveStats}
                                liveTeams={liveTeams}
                                scoringSettings={scoringSettings}
                                teamMatchups={teamMatchups}
                                isExtraOppRow={row.isExtraOppRow}
                                compact={compact}
                                dense={dense}
                                motionDelay={i * 18}
                                targetState={getTargetState({ kind: row.selKind, index: row.selIndex })}
                                statColumns={statColumns}
                                onOpenDetails={onOpenDetails}
                            />
                        ))}
                    </View>
                ))}
                {footer ? <View style={styles.lineupFooter}>{footer}</View> : null}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    blank: { flex: 1, backgroundColor: colors.bgScreen },
    playSurface: { flex: 1, minHeight: 0 },
    playSurfaceTwoPane: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing['3xl'],
    },
    mainColumn: {
        flex: 1,
        minHeight: 0,
        width: '100%',
        alignSelf: 'center',
    },
    mainColumnTwoPane: { alignSelf: 'stretch' },
    rail: { width: layout.railWidth, flexGrow: 0, flexShrink: 0 },
    railContent: { gap: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xl },

    aroundLeague: { gap: spacing.sm },
    aroundLeagueHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    aroundLeagueTitle: { ...textStyles.sectionLabel },
    aroundLeagueMeta: { ...textStyles.meta },
    aroundLeagueScroll: { paddingRight: spacing.md },
    aroundLeagueStack: { gap: spacing.sm },
    aroundLeagueCard: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    aroundLeagueCardFixed: { width: 200 },
    aroundLeagueCardCompact: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    aroundLeagueTeamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    aroundLeagueTeam: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize['2sm'],
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    aroundLeagueTeamLeading: {
        color: colors.textPrimary,
        fontWeight: fontWeight.bold,
    },
    aroundLeagueScore: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        minWidth: 48,
        textAlign: 'right',
        fontVariant: ['tabular-nums'] as const,
    },
    aroundLeagueScoreLeading: {
        color: colors.primaryDark,
    },
    aroundLeagueDivider: {
        height: 1,
        backgroundColor: colors.separator,
        marginVertical: spacing.xs,
    },
    aroundLeagueStatus: {
        ...textStyles.sectionLabel,
        fontSize: fontSize['2xs'],
        marginTop: spacing.xs,
    },
    autoSetBtn: {
        minHeight: 40,
        minWidth: 72,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textWhite, letterSpacing: 0.6 },

    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        marginTop: spacing.md,
    },
    hintText: { flex: 1, fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },
    hintCancel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark, paddingLeft: spacing.lg, paddingVertical: spacing.md },

    lineupContainer: { flex: 1, minHeight: 0 },
    lineupRows: { flex: 1, minHeight: 0 },
    lineupRowsContent: { paddingTop: spacing.md, paddingBottom: spacing.md },
    lineupSection: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden' as const,
        marginBottom: spacing.md,
    },
    lineupSectionBand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 36,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        borderLeftWidth: 3,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    lineupSectionTitle: {
        ...textStyles.sectionLabel,
        flex: 1,
    },
    lineupSectionCount: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
    },
    lineupFooter: {
        gap: spacing.xl,
        paddingTop: spacing.sm,
        paddingBottom: spacing.lg,
    },
    scoreboardFooter: {
        overflow: 'hidden' as const,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
    },

    noLineup: { padding: spacing['4xl'], alignItems: 'center', gap: spacing.lg },
    noLineupText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
    setLineupBtn: { paddingHorizontal: spacing['2xl'], paddingVertical: spacing.md, borderRadius: radii.lg, borderCurve: 'continuous' as const, backgroundColor: colors.primary },
    setLineupBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
