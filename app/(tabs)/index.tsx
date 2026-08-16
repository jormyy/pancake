import {
    Platform,
    View,
    Text,
    Pressable,
    StyleSheet,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ReactNode, useCallback, useEffect, useMemo } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { Scoreboard } from '@/components/Scoreboard'
import { getLineupMoveTargetState, LineupSlot, LineupPlayer, type LineupMoveTargetState } from '@/lib/lineup'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { LiveStatLine } from '@/lib/games'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { DaySelector } from '@/components/DaySelector'
import { ScoreCard } from '@/components/ScoreCard'
import { NoLeagueState } from '@/components/NoLeagueState'
import { AutoSetModal } from '@/components/AutoSetModal'
import { MatchupRow } from '@/components/MatchupRow'
import { LeagueSwitcher } from '@/components/LeagueSwitcher'
import { ActivationOverflowModal } from '@/components/ActivationOverflowModal'
import { useMatchupData } from '@/hooks/use-matchup-data'
import { useLiveStats } from '@/hooks/use-live-stats'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { countLabel, formatPoints, shortName } from '@/lib/format'
import { todayET } from '@/lib/shared/dates'
import { MotionPressable, MotionView } from '@/components/Motion'

function shouldShowScoreboard(selectedDate: string, today: string): boolean {
    return selectedDate === today
}

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number } | { kind: 'taxi'; index: number }

// Mirrors the loaded lineup chrome exactly (header, AUTO control, day
// selector) so nothing moves when rows hydrate — the rows area stays blank
// rather than showing a placeholder that differs from the final UI.
function MatchupLineupLoadingState({
    compact,
    daySelector,
}: {
    compact: boolean
    daySelector?: ReactNode
}) {
    return (
        <View
            style={[styles.lineupContainer, compact && styles.lineupContainerCompact]}
            role="status"
            aria-busy
            aria-label="Matchup lineup loading"
            accessibilityLabel="Matchup lineup loading"
            accessibilityState={{ busy: true }}
        >
            <View style={styles.lineupHeader}>
                <Text
                    style={styles.lineupTitle}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                >
                    Lineup
                </Text>
                <View style={[styles.autoSetBtn, styles.autoSetBtnDisabled]}>
                    <Text style={[styles.autoSetText, styles.autoSetTextDisabled]}>AUTO</Text>
                </View>
            </View>
            {daySelector}
        </View>
    )
}

export default function HomeScreen() {
    const { memberships, current, currentLeague: league, setCurrent, loading: leagueLoading } = useLeagueContext()
    const { user, loading: authLoading } = useAuth()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compact = width < 560 || height < 840
    const dense = height < 620

    const {
        matchup, leagueMatchups, weekDays, selectedDate, setSelectedDate,
        myLineup, oppLineup, matchupLoading, lineupLoading,
        loadMyLineup, loadLineups, refreshSilently, matchupRef,
        error, refresh,
    } = useMatchupData(current, user, league)

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

    const today = todayET()

    // Stay blank while auth/league context loads — flashing the NoLeagueState
    // welcome (or any placeholder) and then swapping it for the real screen is
    // exactly the layout jump this screen must avoid.
    if (authLoading || (leagueLoading && memberships.length === 0)) {
        return <View style={styles.container} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
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

            {error && <ErrorBanner onRetry={refresh} />}

            {matchup ? (
                <View style={styles.playSurface}>
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
                            compact={compact}
                            dense={dense}
                            daySelector={weekDays.length > 0 ? (
                                <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                            ) : null}
                            headerAccessory={
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
                            footer={
                                <>
                                    <AroundLeague matchups={leagueMatchups} compact={compact} />
                                    {shouldShowScoreboard(selectedDate, today) && !dense ? (
                                        <View style={styles.scoreboardFooter}>
                                            <Scoreboard games={todaysGames} myTeamSet={myTeamSet} compact={compact} />
                                        </View>
                                    ) : null}
                                </>
                            }
                        />
                    ) : matchupLoading || lineupLoading ? (
                        <MatchupLineupLoadingState
                            compact={compact}
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
            ) : matchupLoading ? (
                <View style={styles.playSurface} />
            ) : (
                <View style={styles.playSurface}>
                    {league?.status === 'drafting' ? (
                        <EmptyState
                            fullScreen={false}
                            framed
                            icon="flash-on"
                            message="Your draft is live"
                            description="The auction draft is underway — nominate players and build your roster before the season tips off."
                            actionLabel="Go to Draft Room"
                            onAction={() => router.push('/league')}
                        />
                    ) : (
                        <EmptyState
                            fullScreen={false}
                            framed
                            icon="event"
                            message="No matchup this week yet"
                            description="Matchups post before each week starts. Until then, scout the player pool and get your roster ready."
                            actionLabel="Browse Players"
                            onAction={() => router.push('/players')}
                        />
                    )}
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

            <AutoSetModal
                visible={autoSetModalVisible}
                onClose={() => setAutoSetModalVisible(false)}
                onToday={() => { setAutoSetModalVisible(false); doAutoSet(selectedDate) }}
                onWholeWeek={() => { setAutoSetModalVisible(false); doAutoSet(null) }}
                onRestOfSeason={() => { setAutoSetModalVisible(false); doAutoSet(null, true) }}
            />
        </SafeAreaView>
    )
}


function AroundLeague({ matchups, compact }: { matchups: LeagueWeekMatchup[]; compact: boolean }) {
    const { width } = useWindowDimensions()
    const otherMatchups = matchups.filter((item) => !item.isMine)
    if (otherMatchups.length === 0) return null

    const sidePad = compact ? 10 : 16
    const cardGap = compact ? 6 : 8
    // On narrow screens, size cards so one fits fully with a deliberate peek
    // of the next card's left (name) edge — a score never sits under the clip.
    const cardWidth = compact ? Math.min(220, width - sidePad - 72) : 190

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
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={compact ? cardWidth + cardGap : undefined}
                decelerationRate={compact ? 'fast' : undefined}
                contentContainerStyle={[styles.aroundLeagueScroll, compact && styles.aroundLeagueScrollCompact]}
            >
                {otherMatchups.map((item) => {
                    const homeScore = item.homePoints
                    const awayScore = item.awayPoints
                    const homeLeading = homeScore != null && (awayScore == null || homeScore >= awayScore)
                    const awayLeading = awayScore != null && (homeScore == null || awayScore > homeScore)
                    return (
                        <View key={item.id} style={[styles.aroundLeagueCard, compact && [styles.aroundLeagueCardCompact, { width: cardWidth }]]}>
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
                })}
            </ScrollView>
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
    compact,
    dense,
    daySelector,
    headerAccessory,
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
    compact: boolean
    dense: boolean
    daySelector?: ReactNode
    headerAccessory?: ReactNode
    hint?: ReactNode
    footer?: ReactNode
}) {
    const maxBench = Math.max(myLineup.bench.length, oppLineup.bench.length)
    const maxIR = Math.max(myLineup.ir.length, oppLineup.ir.length)
    const maxTaxi = Math.max(myLineup.taxi.length, oppLineup.taxi.length)
    const sections = useMemo(
        () => [
            {
                key: 'starters' as const,
                label: 'Starters',
                count: myLineup.starters.length,
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
                color: colors.textMuted,
                rows: Array.from({ length: maxBench }, (_, i) => ({
                    key: `b${i}`,
                    myPlayer: myLineup.bench[i] ?? null,
                    oppPlayer: oppLineup.bench[i] ?? null,
                    slotType: 'BE',
                    selKind: 'bench' as const,
                    selIndex: i,
                    isExtraOppRow: i >= myLineup.bench.length,
                })),
            },
            {
                key: 'ir' as const,
                label: 'Injured Reserve',
                count: maxIR,
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
        [maxBench, maxIR, maxTaxi, myLineup, oppLineup],
    )

    return (
        <View style={[styles.lineupContainer, compact && styles.lineupContainerCompact]}>
            <View style={styles.lineupHeader}>
                <Text
                    style={styles.lineupTitle}
                    role="heading"
                    aria-level={2}
                    accessibilityRole="header"
                >
                    Lineup
                </Text>
                {headerAccessory}
            </View>
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
                            <Text style={styles.lineupSectionCount}>{section.count}</Text>
                        </View>
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
    container: { flex: 1, backgroundColor: colors.bgScreen },

    playSurface: { flex: 1, minHeight: 0 },
    aroundLeague: {
        paddingTop: 0,
        paddingBottom: 2,
    },
    aroundLeagueHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 3,
    },
    aroundLeagueTitle: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
    },
    aroundLeagueMeta: {
        fontSize: fontSize['2sm'],
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    aroundLeagueScroll: {
        paddingHorizontal: 16,
        gap: 8,
    },
    aroundLeagueScrollCompact: {
        paddingHorizontal: 10,
        gap: 6,
    },
    aroundLeagueCard: {
        width: 190,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    aroundLeagueCardCompact: {
        width: 184,
        paddingHorizontal: 9,
        paddingVertical: 6,
    },
    aroundLeagueTeamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    aroundLeagueTeam: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    aroundLeagueTeamLeading: {
        color: colors.textPrimary,
    },
    aroundLeagueScore: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        minWidth: 48,
        textAlign: 'right',
    },
    aroundLeagueScoreLeading: {
        color: colors.primaryDark,
    },
    aroundLeagueDivider: {
        height: 1,
        backgroundColor: colors.separator,
        marginVertical: 3,
    },
    aroundLeagueStatus: {
        marginTop: 3,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.5,
        textTransform: 'uppercase' as const,
    },
    autoSetBtn: {
        height: 26,
        paddingHorizontal: 14,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1.5,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.extrabold, color: colors.primaryDark, letterSpacing: 0.6 },
    autoSetBtnDisabled: {
        backgroundColor: colors.bgMuted,
        borderColor: colors.borderLight,
    },
    autoSetTextDisabled: { color: colors.textPlaceholder },

    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 12,
        paddingVertical: 7,
        marginTop: 8,
    },
    hintText: { flex: 1, fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.medium },
    hintCancel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark, paddingLeft: 12 },

    lineupContainer: { flex: 1, minHeight: 0, paddingHorizontal: 12, paddingBottom: 8 },
    lineupContainerCompact: { paddingHorizontal: 8 },
    lineupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 0,
        paddingBottom: 2,
    },
    lineupTitle: {
        flex: 1,
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    lineupRows: { flex: 1, minHeight: 0 },
    lineupRowsContent: { paddingTop: 4, paddingBottom: 8 },
    lineupSection: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden' as const,
        marginBottom: 8,
    },
    lineupSectionBand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderLeftWidth: 3,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    lineupSectionTitle: {
        flex: 1,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    lineupSectionCount: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
    },
    lineupFooter: {
        gap: spacing.md,
        paddingTop: spacing.sm,
        paddingBottom: spacing.lg,
    },
    scoreboardFooter: {
        overflow: 'hidden' as const,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
    },

    noLineup: { padding: 32, alignItems: 'center', gap: 12 },
    noLineupText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
    setLineupBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderCurve: 'continuous' as const, backgroundColor: colors.primary },
    setLineupBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    noMatchup: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 32 },
    noMatchupText: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    noMatchupSub: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center' },

    dateLabel: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingVertical: 10 },

})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
