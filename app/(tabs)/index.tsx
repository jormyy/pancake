import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useMemo } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { Scoreboard } from '@/components/Scoreboard'
import { LineupSlot, LineupPlayer } from '@/lib/lineup'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { LiveStatLine } from '@/lib/games'
import { colors, fontSize, fontWeight, palette, radii, spacing } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
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
import { shortName } from '@/lib/format'
import { todayET } from '@/lib/shared/dates'
import { MotionPressable, MotionView } from '@/components/Motion'

function shouldShowScoreboard(selectedDate: string, today: string): boolean {
    return selectedDate === today
}

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type Sel = { kind: 'starter'; index: number } | { kind: 'bench'; index: number } | { kind: 'ir'; index: number } | { kind: 'taxi'; index: number }

export default function HomeScreen() {
    const { memberships, current, currentLeague: league, setCurrent, loading } = useLeagueContext()
    const { user } = useAuth()
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

    const {
        selected, setSelected, saving, autoSetting,
        autoSetModalVisible, setAutoSetModalVisible,
        activationOverflowPending, setActivationOverflowPending, activationOverflowSaving,
        handleTap, handleOverflowDrop, handleOverflowMoveToIR, handleOverflowMoveToTaxi,
        doAutoSet, handleAutoSet,
    } = useLineupActions({ matchup, myLineup, league, selectedDate, startedTeams, loadMyLineup })

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
                          ...myLineup.starters.map((s) => s.player?.nbaTeam),
                          ...myLineup.bench.map((p) => p.nbaTeam),
                          ...myLineup.ir.map((p) => p.nbaTeam),
                          ...myLineup.taxi.map((p) => p.nbaTeam),
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

    if (loading) return <LoadingScreen />
    if (memberships.length === 0) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
            <LeagueSwitcher
                memberships={memberships}
                currentId={current?.id}
                onSelect={(membership) => {
                    const fullMembership = memberships.find((m) => m.id === membership.id)
                    if (fullMembership) setCurrent(fullMembership)
                }}
                compact={compact}
            />

            {error && (
                <Pressable style={styles.errorBanner} onPress={refresh}>
                    <Text style={styles.errorBannerText}>Failed to load. Tap to retry.</Text>
                </Pressable>
            )}

            {matchupLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
            ) : matchup ? (
                <View style={styles.playSurface}>
                    {shouldShowScoreboard(selectedDate, today) && !dense
                        ? <Scoreboard games={todaysGames} myTeamSet={myTeamSet} compact={compact} />
                        : <Text style={styles.dateLabel}>Showing lineup for {selectedDate}</Text>
                    }
                    <ScoreCard matchup={matchup} compact={compact} />
                    <AroundLeague matchups={leagueMatchups} compact={compact} />

                    {weekDays.length > 0 && (
                        <DaySelector days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compact} />
                    )}

                    <View style={[styles.lineupToolbar, compact && styles.lineupToolbarCompact]}>
                        <MotionPressable
                            style={styles.autoSetBtn}
                            onPress={handleAutoSet}
                            disabled={autoSetting || saving}
                            pressedScale={0.92}
                        >
                            {autoSetting
                                ? <ActivityIndicator size="small" color={colors.primary} />
                                : <Text style={styles.autoSetText}>AUTO</Text>}
                        </MotionPressable>

                        {selected && (
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
                        )}
                    </View>

                    {lineupLoading ? (
                        <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
                    ) : myLineup && oppLineup ? (
                        <MatchupLineupView
                            myLineup={myLineup}
                            oppLineup={oppLineup}
                            selected={selected}
                            onTap={handleTap}
                            saving={saving}
                            playingTeams={todayPlayingTeams}
                            liveStats={liveStats}
                            liveTeams={liveTeams}
                            scoringSettings={scoringSettings}
                            teamMatchups={teamMatchups}
                            compact={compact}
                            dense={dense}
                        />
                    ) : (
                        <View style={styles.noLineup}>
                            <Text style={styles.noLineupText}>No lineup set for this day.</Text>
                            <Pressable style={styles.setLineupBtn} onPress={handleAutoSet} disabled={autoSetting}>
                                <Text style={styles.setLineupBtnText}>Auto-Set Lineup</Text>
                            </Pressable>
                        </View>
                    )}
                </View>
            ) : (
                <View style={styles.playSurface}>
                    {shouldShowScoreboard(selectedDate, today)
                        ? <Scoreboard games={todaysGames} myTeamSet={myTeamSet} compact={compact} />
                        : <Text style={styles.dateLabel}>Showing lineup for {selectedDate}</Text>
                    }
                    <View style={styles.noMatchup}>
                        <Text style={styles.noMatchupText}>No matchup this week yet.</Text>
                        <Text style={styles.noMatchupSub}>Matchups are generated before each week starts.</Text>
                    </View>
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
    const otherMatchups = matchups.filter((item) => !item.isMine)
    if (otherMatchups.length === 0) return null

    const scoreText = (score: number | null) => score == null ? '—' : score.toFixed(1)

    return (
        <View style={styles.aroundLeague}>
            <View style={styles.aroundLeagueHeader}>
                <Text style={styles.aroundLeagueTitle}>Around the league</Text>
                <Text style={styles.aroundLeagueMeta}>{otherMatchups.length} matchup{otherMatchups.length === 1 ? '' : 's'}</Text>
            </View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={[styles.aroundLeagueScroll, compact && styles.aroundLeagueScrollCompact]}
            >
                {otherMatchups.map((item) => {
                    const homeScore = item.homePoints
                    const awayScore = item.awayPoints
                    const homeLeading = homeScore != null && (awayScore == null || homeScore >= awayScore)
                    const awayLeading = awayScore != null && (homeScore == null || awayScore > homeScore)
                    return (
                        <View key={item.id} style={[styles.aroundLeagueCard, compact && styles.aroundLeagueCardCompact]}>
                            <View style={styles.aroundLeagueTeamRow}>
                                <Text style={[styles.aroundLeagueTeam, homeLeading && styles.aroundLeagueTeamLeading]} numberOfLines={1}>
                                    {item.homeTeamName}
                                </Text>
                                <Text style={[styles.aroundLeagueScore, homeLeading && styles.aroundLeagueScoreLeading]}>
                                    {scoreText(item.homePoints)}
                                </Text>
                            </View>
                            <View style={styles.aroundLeagueDivider} />
                            <View style={styles.aroundLeagueTeamRow}>
                                <Text style={[styles.aroundLeagueTeam, awayLeading && styles.aroundLeagueTeamLeading]} numberOfLines={1}>
                                    {item.awayTeamName}
                                </Text>
                                <Text style={[styles.aroundLeagueScore, awayLeading && styles.aroundLeagueScoreLeading]}>
                                    {scoreText(item.awayPoints)}
                                </Text>
                            </View>
                            <Text style={styles.aroundLeagueStatus}>{item.isFinalized ? 'Final' : 'Live week'}</Text>
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
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    compact,
    dense,
}: {
    myLineup: LineupData
    oppLineup: LineupData
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    compact: boolean
    dense: boolean
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
                color: palette.gray500,
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
        <View style={styles.lineupContainer}>
            <View style={styles.lineupHeader}>
                <Text style={styles.lineupTitle}>Lineup</Text>
                <Text style={styles.lineupMeta}>Starters, bench, IR, and taxi</Text>
            </View>

            <ScrollView
                style={styles.lineupRows}
                contentContainerStyle={styles.lineupRowsContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
            >
                {sections.map((section) => (
                    <View key={section.key} style={styles.lineupSection}>
                        <View style={[styles.lineupSectionBand, { borderLeftColor: section.color }]}>
                            <Text style={[styles.lineupSectionTitle, { color: section.color }]}>{section.label}</Text>
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
                                selected={selected}
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
                            />
                        ))}
                    </View>
                ))}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    playSurface: { flex: 1, minHeight: 0 },
    aroundLeague: {
        paddingTop: 2,
        paddingBottom: 6,
    },
    aroundLeagueHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    aroundLeagueTitle: {
        fontSize: 15,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    aroundLeagueMeta: {
        fontSize: 12,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    aroundLeagueScroll: {
        paddingHorizontal: 16,
        gap: 10,
    },
    aroundLeagueScrollCompact: {
        paddingHorizontal: 12,
        gap: 8,
    },
    aroundLeagueCard: {
        width: 220,
        padding: 12,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    aroundLeagueCardCompact: {
        width: 186,
        padding: 10,
    },
    aroundLeagueTeamRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    aroundLeagueTeam: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    aroundLeagueTeamLeading: {
        color: colors.textPrimary,
    },
    aroundLeagueScore: {
        fontSize: 17,
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
        marginVertical: 7,
    },
    aroundLeagueStatus: {
        marginTop: 8,
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textPlaceholder,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    lineupToolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    lineupToolbarCompact: {
        paddingVertical: 5,
    },
    autoSetBtn: {
        height: 30,
        paddingHorizontal: 18,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1.5,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoSetText: { fontSize: 11, fontWeight: '800', color: colors.primaryDark, letterSpacing: 0.6 },

    hint: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 12,
        paddingVertical: 7,
    },
    hintText: { flex: 1, fontSize: 13, color: colors.primaryDark, fontWeight: '500' },
    hintCancel: { fontSize: 13, fontWeight: '700', color: colors.primaryDark, paddingLeft: 12 },

    lineupContainer: { flex: 1, minHeight: 0, paddingHorizontal: 16, paddingBottom: 8 },
    lineupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 10,
        paddingBottom: 8,
    },
    lineupTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    lineupMeta: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    lineupRows: { flex: 1, minHeight: 0 },
    lineupRowsContent: { paddingBottom: 8 },
    lineupSection: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden' as const,
        marginBottom: 12,
    },
    lineupSectionBand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
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

    noLineup: { padding: 32, alignItems: 'center', gap: 12 },
    noLineupText: { fontSize: 14, color: colors.textPlaceholder, textAlign: 'center' },
    setLineupBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderCurve: 'continuous' as const, backgroundColor: colors.primary },
    setLineupBtnText: { color: colors.textWhite, fontWeight: '700', fontSize: 14 },

    noMatchup: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 32 },
    noMatchupText: { fontSize: 16, fontWeight: '600', color: colors.textSecondary },
    noMatchupSub: { fontSize: 13, color: colors.textPlaceholder, textAlign: 'center' },

    errorBanner: {
        backgroundColor: colors.danger,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    errorBannerText: { fontSize: 13, fontWeight: '600', color: colors.textWhite, textAlign: 'center' },

    dateLabel: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 10 },

})
