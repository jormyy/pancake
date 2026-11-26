import { AssetSelectionRow } from '@/components/roster/LockedAssetNotice'
import { useScreenView } from '@/hooks/use-screen-view'
import { readAssetLocks, type AssetLock } from '@/lib/locked-assets'
import { cachedScreenView, readScreenView, subscribeScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import type { LineupView, RosterView } from '@/lib/cache/view-types'
import { LineupPinControl } from '@/components/LineupPinControl'
import { optimizeLineupDate, setLineupPlayerPin, type LineupPin } from '@/lib/lineup/pins'
import { IrNotices } from '@/components/lineup/IrNotices'
import { useAutoIrNotices } from '@/hooks/use-auto-ir-notices'
import { SectionBand } from '@/components/ui/SectionBand'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { ScreenStatusScrollView as ScrollView, ScreenStatusOverlay, ScreenStatusProvider } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'

import { DaySelector } from '@/components/DaySelector'


import { breakpoints, colors, componentTokens, controlSize, fontWeight, layout, radii, spacing, textStyles, uiColors, typeScale } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { onLifecycle, readsAllowed } from '@/lib/lifecycle'
import { useAuth } from '@/hooks/use-auth'
import { getGameDisplayState } from '@/lib/home-surface'
import { useLineupActions } from '@/hooks/use-lineup-actions'

import { leagueSnapshotRevision } from '@/lib/league-changes'
import { getErrorMessage } from '@/lib/shared/errors'
import { getLineupMoveTargetState, LineupContext, LineupPlayer, LineupSlot, WeekDay, type LineupMoveTargetState } from '@/lib/lineup'

import { todayLeague, resolveLeagueTimezone } from '@/lib/timezone'
import { useLeagueDay } from '@/hooks/use-league-day'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { invalidateWeekNumberCache } from '@/lib/shared/week'
import { readStoredAuthState } from '@/lib/supabase'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { useScope, type ScopeTicket } from '@/hooks/use-scope'
import { readLineupSnapshot, saveLineupSnapshot, discardLineupSnapshot, type LineupSnapshot } from '@/lib/lineup/snapshot'
import { showAlert } from '@/lib/alert'
import { rosterLimits } from '@/lib/roster-capacity'
import { useLocalSearchParams } from 'expo-router'
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { MotionPressable, MotionView } from '@/components/Motion'
import { Page, PageHeader, usePageMetrics } from '@/components/ui'
import { useGoBack } from '@/components/ui/useGoBack'

const TWO_COLUMN_MIN_WIDTH = 940

const StarterRow = memo(function StarterRow({
    slot,
    index,
    isSelected,
    liveTeams,
    startedTeams,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
    locks,
    pinDisabled,
    onPinChange,
    pinCompact,
}: {
    slot: LineupSlot
    index: number
    isSelected: boolean
    liveTeams: Set<string>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
    locks: readonly AssetLock[]
    pinDisabled: boolean
    onPinChange: (player: LineupPlayer, pin: LineupPin) => void
    pinCompact: boolean
}) {
    const p = slot.player
    const isLocked = !!(p?.nbaTeam && startedTeams.has(p.nbaTeam))
    const isLive = !!(p?.nbaTeam && liveTeams.has(p.nbaTeam))
    const status = isLocked ? isLive ? 'LIVE' : 'LOCK' : targetState === 'valid' ? 'MOVE' : ''
    const starterMatchup = p?.nbaTeam ? teamMatchups.get(p.nbaTeam) : undefined
    const starterMatchupLabel = p?.nbaTeam
        ? (starterMatchup ? `${starterMatchup.isHome ? 'vs' : '@'} ${starterMatchup.opponent}` : '· No game')
        : null

    return (
        <View style={[
            styles.rowLine,
            index > 0 && styles.divider,
            isSelected && styles.selectedRow,
            targetState === 'valid' && styles.validTargetRow,
            targetState === 'invalid' && styles.invalidTargetRow,
        ]}><AssetSelectionRow locks={locks} component={MotionPressable}
            style={styles.slotRow}
            onPress={onPress}
            disabled={disabled || isLocked || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            label={p ? `${slot.slotType} ${p.displayName}` : `Empty ${slot.slotType} slot`}
            accessibilityHint={targetState === 'valid' ? `Move here to use the ${slot.slotType} slot` : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || isLocked || targetState === 'invalid' }}
        >
            <Text style={styles.slotLabel}>{slot.slotType}</Text>
            {p ? (
                <>
<PlayerRowContent locks={locks} name={p.displayName} nbaId={p.nbaId} team={p.nbaTeam} positions={p.eligiblePositions}
                        playerId={p.playerId} yearsExp={p.yearsExp} careerGames={p.careerGames} injuryStatus={p.injuryStatus} stats={starterMatchupLabel ?? undefined} />
                    {pinCompact ? null : <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>{status}</Text>}
                </>
            ) : (
                <Text style={styles.emptySlot}>Empty</Text>
            )}
        </AssetSelectionRow>
            {p && pinCompact && status ? <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>{status}</Text>
                : p ? <LineupPinControl compact={pinCompact} name={p.displayName} pin={p.lineupPin ?? null} disabled={pinDisabled || isLocked}
                onChange={pin => onPinChange(p, pin)} /> : null}
        </View>
    )
})

const BenchRow = memo(function BenchRow({
    player,
    index,
    isSelected,
    liveTeams,
    startedTeams,
    teamMatchups,
    onPress,
    disabled,
    readOnly,
    targetState,
    locks,
    pinDisabled,
    onPinChange,
    pinCompact,
}: {
    player: LineupPlayer
    index: number
    isSelected: boolean
    liveTeams: Set<string>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    onPress: () => void
    disabled: boolean
    readOnly: boolean
    targetState: LineupMoveTargetState
    locks: readonly AssetLock[]
    pinDisabled: boolean
    onPinChange: (player: LineupPlayer, pin: LineupPin) => void
    pinCompact: boolean
}) {
    const isLocked = !!(player.nbaTeam && startedTeams.has(player.nbaTeam))
    const isLive = !!(player.nbaTeam && liveTeams.has(player.nbaTeam))
    const status = isLocked ? isLive ? 'LIVE' : 'LOCK' : targetState === 'valid' ? 'MOVE' : ''
    const benchMatchup = player.nbaTeam ? teamMatchups.get(player.nbaTeam) : undefined
    const injuryStatus = player.injuryStatus?.trim().toLowerCase() ?? ''
    const pinNote = injuryStatus === 'out' || injuryStatus.startsWith('ir')
        ? 'Pinned, but Out'
        : benchMatchup ? 'Pinned, no slot' : 'Pinned, no game'
    const benchMatchupLabel = player.nbaTeam
        ? (benchMatchup ? `${benchMatchup.isHome ? 'vs' : '@'} ${benchMatchup.opponent}` : '· No game')
        : null

    return (
        <View style={[
            index > 0 && styles.divider,
            isSelected && styles.selectedRow,
            targetState === 'valid' && styles.validTargetRow,
            targetState === 'invalid' && styles.invalidTargetRow,
        ]}><View style={styles.rowLine}><AssetSelectionRow locks={locks} component={MotionPressable}
            style={styles.benchRow}
            onPress={onPress}
            disabled={disabled || isLocked || targetState === 'invalid'}
            disabledOpacity={readOnly ? 1 : undefined}
            accessibilityRole="button"
            label={`Bench ${player.displayName}`}
            accessibilityHint={targetState === 'valid' ? 'Move here to place the selected player on the bench' : undefined}
            accessibilityState={{ selected: isSelected, disabled: disabled || isLocked || targetState === 'invalid' }}
        >
<PlayerRowContent locks={locks} name={player.displayName} nbaId={player.nbaId} team={player.nbaTeam} positions={player.eligiblePositions}
                        playerId={player.playerId} yearsExp={player.yearsExp} careerGames={player.careerGames} injuryStatus={player.injuryStatus} stats={benchMatchupLabel ?? undefined} />
                    {pinCompact ? null : <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>{status}</Text>}
        </AssetSelectionRow>
            {pinCompact && status ? <Text style={[styles.rowStatus, isLocked ? styles.lockedBadge : styles.moveBadge]}>{status}</Text>
                : <LineupPinControl compact={pinCompact} name={player.displayName} pin={player.lineupPin ?? null} disabled={pinDisabled || isLocked}
                onChange={pin => onPinChange(player, pin)} />}
        </View>
            {player.lineupPin === 'start' && !isLocked ? <Text style={styles.pinNote}>{pinNote}</Text> : null}
        </View>
    )
})

function LineupFrame({ inline, children }: { inline: boolean; children: ReactNode }) {
    return inline ? <View accessibilityLabel="Your lineup">{children}</View> : <Page title="Lineup">{children}</Page>
}

function LineupBody({ inline, padX, twoColumn, children }: { inline: boolean; padX: number; twoColumn: boolean; children: ReactNode }) {
    const contentStyle = [styles.scroll, { paddingHorizontal: padX }, twoColumn && styles.scrollWide]
    return inline ? <View style={contentStyle}>{children}</View> : <ScrollView style={styles.scroller} contentContainerStyle={contentStyle}>{children}</ScrollView>
}

export function LineupEditor({ inline = false }: { inline?: boolean }) {
    const recoverLineup = useRef<(() => boolean) | null>(null)
    useEffect(() => holdPwaUpdate('lineup editor', () => recoverLineup.current?.() === true), [])
    const back = useGoBack('/roster')
    const { padX, usableWidth, compact: compactDays } = usePageMetrics()
    // Wide screens set starters and bench side by side, so a move never needs a scroll.
    const twoColumn = !inline && usableWidth >= TWO_COLUMN_MIN_WIDTH
    const pinCompact = usableWidth < breakpoints.phone
    const { playerId: playerIdParam } = useLocalSearchParams<{ playerId?: string | string[] }>()
    const requestedPlayerId = Array.isArray(playerIdParam) ? playerIdParam[0] : playerIdParam
    const { user } = useAuth()
    const { current, currentLeague, online, membershipValidated, membershipError, refresh: refreshLeague } = useLeagueContext()
    const limits = rosterLimits(currentLeague)
    const userId = user?.id
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const lockView = useScreenView<RosterView>(membershipValidated && userId && memberId && leagueId
        ? screenScope('roster', leagueId, memberId, {}, userId) : null)
    const locksFor = (player: LineupPlayer | null) => player
        ? lockView.data?.lockedAssets?.filter(lock => lock.assetKind === 'player' && lock.assetId === player.playerId) ?? readAssetLocks(player) : []
    const leagueRevision = JSON.stringify(currentLeague)
    const timezone = resolveLeagueTimezone(currentLeague?.timezone)
    const currentDay = useLeagueDay(timezone)
    const snapshotScope = useMemo(() => userId && memberId && leagueId
        ? { ownerId: userId, memberId, leagueId, day: currentDay } : null,
    [userId, memberId, leagueId, currentDay])

    const [ctx, setCtx] = useState<LineupContext | null>(null)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [selectedDate, setSelectedDate] = useState<string>(
        () => todayLeague(timezone),
    )
    const [starters, setStarters] = useState<LineupSlot[]>([])
    const [dataDate, setDataDate] = useState(selectedDate)
    const [bench, setBench] = useState<LineupPlayer[]>([])
    const [benchSlots, setBenchSlots] = useState(0)
    const [reserves, setReserves] = useState<{ ir: LineupPlayer[]; taxi: LineupPlayer[] }>({ ir: [], taxi: [] })
    const [pinSaving, setPinSaving] = useState(false)
    const pinPendingRef = useRef(false)
    const [lineupLoading, setLineupLoading] = useState(true)
    const [lineupRefreshing, setLineupRefreshing] = useState(false)
    const [lineupError, setLineupError] = useState<string | null>(null)
    const preselectedKeyRef = useRef<string | null>(null)
    const ownerKey = snapshotScope ? `${snapshotScope.ownerId}:${snapshotScope.memberId}:${snapshotScope.leagueId}:${snapshotScope.day}` : null
    const activeOwnerRef = useRef(ownerKey)
    activeOwnerRef.current = ownerKey
    const loadScope = useScope(ownerKey)
    const selectedDateRef = useRef(selectedDate)
    selectedDateRef.current = selectedDate
    const [savedSnapshot, setSavedSnapshot] = useState(true)
    const [contextAuthority, setContextAuthority] = useState(false)
    const loadPendingRef = useRef<{ key: string; ticket: ScopeTicket; promise: Promise<boolean> } | null>(null)
    const [dataOwnerKey, setDataOwnerKey] = useState(ownerKey)
    const dataOwnerRef = useRef(dataOwnerKey)
    dataOwnerRef.current = dataOwnerKey

    const [liveView, setLiveView] = useState<{ owner: string | null; value?: LineupView }>(() => ({ owner: ownerKey, value: snapshotScope ? cachedScreenView<LineupView>(screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: selectedDate }, snapshotScope.ownerId))?.value : undefined }))
    const liveData = liveView.owner === ownerKey && liveView.value?.date === selectedDate ? liveView.value : undefined
    const startedTeams = useMemo(() => new Set(liveData?.startedTeams ?? []), [liveData])
    const todaysGames = useMemo(() => liveData?.games ?? [], [liveData])
    const teamMatchups = useMemo(() => new Map(Object.entries(liveData?.teamMatchups ?? {})), [liveData])
    const freshness = !online ? 'offline' as const : liveData ? 'fresh' as const : 'refreshing' as const
    const { ready: gamesReady, liveTeams } = useMemo(() => getGameDisplayState(todaysGames, freshness), [todaysGames, freshness])

    const readAllowed = useCallback(() => readsAllowed() && currentDay === todayLeague(timezone) && readStoredAuthState().session?.user.id === userId,
        [userId, currentDay, timezone])

    const applySnapshot = useCallback((value: Pick<LineupSnapshot, 'context' | 'date' | 'days' | 'starters' | 'bench' | 'benchSlots' | 'ir' | 'taxi' | 'optimizerEnabled'>, saved: boolean) => {
        setDataOwnerKey(ownerKey)
        setCtx(value.context)
        setWeekDays(value.days)
        setSelectedDate(value.date)
        setDataDate(value.date)
        selectedDateRef.current = value.date
        setStarters(value.starters)
        setBench(value.bench)
        setBenchSlots(value.benchSlots ?? 0)
        setReserves({ ir: value.ir ?? [], taxi: value.taxi ?? [] })
        setSavedSnapshot(saved)
        if (saved) setContextAuthority(false)
    }, [ownerKey])

    const failedLoad = useCallback((error: unknown) => {
        setContextAuthority(false)
        console.error(error)
        const code = (error as { code?: string; status?: number })?.code
        const status = (error as { status?: number })?.status
        if (snapshotScope && (['42501', '28000', 'PGRST301', 'PGRST302', 'PGRST303', 'PGRST116'].includes(code ?? '')
            || status === 401 || status === 403 || status === 404)) {
            discardLineupSnapshot(snapshotScope)
            setCtx(null)
            setStarters([])
            setBench([])
        }
        setSavedSnapshot(true)
        setLineupError(getErrorMessage(error) ?? 'Could not load lineup.')
    }, [snapshotScope])

    const missingContextPending = !snapshotScope && !membershipValidated && !membershipError
    const missingContextError = snapshotScope ? null : membershipError?.message ?? null
    const lastReadRef = useRef<{ ownerKey: string; generation: number; date: string; at: number; leagueRevision: string; streamRevision: string | null } | null>(null)
    const load = useCallback((requestedDate?: string): Promise<boolean> => {
        if (!snapshotScope || !ownerKey) {
            setCtx(null); setStarters([]); setBench([]); setWeekDays([])
            setLineupLoading(missingContextPending)
            setLineupError(missingContextError)
            return Promise.resolve(false)
        }
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return Promise.resolve(false)
        const wanted = requestedDate ?? (dataOwnerRef.current === ownerKey ? selectedDateRef.current : currentDay)
        const pendingKey = `${ownerKey}:${sessionGeneration()}:${online}:${wanted}:${leagueRevision}`
        const joinable = loadPendingRef.current
        if (joinable?.key === pendingKey && joinable.ticket.live()) return joinable.promise
        const ticket = loadScope.latest(readAllowed)
        const generation = sessionGeneration()
        const cached = readLineupSnapshot(snapshotScope, wanted)
        if (cached) applySnapshot(cached, true)
        else if (dataOwnerRef.current !== ownerKey) {
            setCtx(null); setStarters([]); setBench([]); setWeekDays([])
        } else if (!online) {
            // Keep same-owner date controls, but never show another day's domain rows.
            setDataDate(''); setStarters([]); setBench([])
        }
        setLineupLoading(!cached)
        setLineupRefreshing(Boolean(cached && online))
        setSavedSnapshot(true)
        setContextAuthority(false)
        setLineupError(null)
        if (!online) {
            setLineupLoading(false)
            setLineupRefreshing(false)
            if (!cached) setLineupError('No saved lineup for this day. Connect to load it.')
            return Promise.resolve(false)
        }
        const task = (async () => {
            try {
                const lineup = await readScreenView<LineupView>(screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: wanted }, snapshotScope.ownerId))
                const lineupCtx = { seasonId: lineup.context.seasonId!, seasonYear: lineup.context.seasonYear, weekNumber: lineup.context.weekNumber ?? 1, today: lineup.context.today }
                const date = lineup.date
                const value = { context: lineupCtx, date, days: lineup.weekDays, starters: lineup.starters, bench: lineup.bench, benchSlots: lineup.benchSlots, ir: lineup.ir, taxi: lineup.taxi, optimizerEnabled: lineup.optimizer?.enabled ?? false }
                return ticket.commit(() => {
                    setLiveView({ owner: ownerKey, value: lineup })
                    saveLineupSnapshot(snapshotScope, generation, value)
                    applySnapshot(value, false)
                    setContextAuthority(true)
                    lastReadRef.current = { ownerKey, generation, date, at: Date.now(), leagueRevision, streamRevision: leagueSnapshotRevision(snapshotScope.leagueId, 'lineup') }
                })
            } catch (error) {
                ticket.commit(() => {
                    lastReadRef.current = null
                    failedLoad(error)
                })
                return false
            } finally {
                ticket.commit(() => { setLineupLoading(false); setLineupRefreshing(false) })
            }
        })()
        const pending = { key: pendingKey, ticket, promise: task }
        loadPendingRef.current = pending
        void task.finally(() => {
            if (loadPendingRef.current !== pending) return
            loadPendingRef.current = null
            const lastRead = lastReadRef.current
            if (lastRead?.ownerKey === ownerKey && lastRead.generation === generation && lastRead.at === 0
                && ticket.live()) void load(selectedDateRef.current)
        })
        return task
    }, [snapshotScope, ownerKey, online, currentDay, applySnapshot, loadScope, readAllowed, failedLoad, leagueRevision, missingContextPending, missingContextError])

    useEffect(() => {
        if (!snapshotScope) return
        const scope = screenScope('lineup', snapshotScope.leagueId, snapshotScope.memberId, { date: selectedDate }, snapshotScope.ownerId)
        return subscribeScreenView(scope, () => { if (cachedScreenView(scope)?.dirty) { lastReadRef.current = null; void load() } })
    }, [snapshotScope, selectedDate, load])

    const previousOnlineRef = useRef(online)
    const contextDayRef = useRef(currentDay)
    const leagueSnapshotRef = useRef(leagueRevision)
    useEffect(() => {
        if ((online && !previousOnlineRef.current) || contextDayRef.current !== currentDay || leagueSnapshotRef.current !== leagueRevision) {
            invalidateSeasonCache(leagueId)
            invalidateWeekNumberCache()
        }
        previousOnlineRef.current = online
        contextDayRef.current = currentDay
        leagueSnapshotRef.current = leagueRevision
        void load()
    }, [load, online, currentDay, leagueId, leagueRevision])
    useEffect(() => {
        const refresh = () => {
            if (!readsAllowed()) {
                if (loadPendingRef.current) {
                    loadScope.supersede()
                    loadPendingRef.current = null
                    lastReadRef.current = null
                    setContextAuthority(false)
                    setSavedSnapshot(true)
                    setLineupLoading(false)
                    setLineupRefreshing(false)
                }
                return
            }
            const day = todayLeague(timezone)
            if (day !== currentDay) return
            else {
                const lastRead = lastReadRef.current
                if (lastRead?.ownerKey === ownerKey && lastRead.generation === sessionGeneration()
                    && lastRead.leagueRevision === leagueRevision && lastRead.date === selectedDateRef.current
                    && lastRead.streamRevision === (leagueId ? leagueSnapshotRevision(leagueId, 'lineup') : null) && Date.now() - lastRead.at < 300_000) return
                invalidateSeasonCache(leagueId)
                invalidateWeekNumberCache()
                void load()
            }
        }
        return onLifecycle(['focus', 'offline', 'visible', 'hidden'], refresh)
    }, [currentDay, load, loadScope, leagueId, ownerKey, leagueRevision, timezone])

    const ownsLineup = dataOwnerKey === ownerKey
    const visibleCtx = ownsLineup ? ctx : null
    const { notices: irNotices, refresh: refreshIrNotices } = useAutoIrNotices({
        leagueId: snapshotScope?.leagueId ?? null,
        seasonId: visibleCtx?.seasonId ?? null,
        ownerKey,
        online,
    })
    const matchingDay = dataDate === selectedDate
    const visibleStarters = useMemo(() => ownsLineup && matchingDay ? starters : [], [ownsLineup, matchingDay, starters])
    const visibleBench = useMemo(() => ownsLineup && matchingDay ? bench : [], [bench, matchingDay, ownsLineup])
    const readOnly = !ownsLineup || !matchingDay || (online && (!contextAuthority || savedSnapshot || lineupLoading || lineupRefreshing || Boolean(lineupError)))
    const savedMatchups = useMemo(() => {
        const teams = weekDays.find((d) => d.date === selectedDate)?.playingTeams ?? []
        const result = new Map<string, { opponent: string; isHome: boolean }>()
        for (let i = 0; i + 1 < teams.length; i += 2) {
            result.set(teams[i], { opponent: teams[i + 1], isHome: true })
            result.set(teams[i + 1], { opponent: teams[i], isHome: false })
        }
        return result
    }, [weekDays, selectedDate])
    const displayedMatchups = readOnly ? savedMatchups : teamMatchups
    const actionOwner = current && visibleCtx && currentLeague ? {
        memberId: current.id,
        leagueId: currentLeague.id,
        seasonId: visibleCtx.seasonId,
        weekNumber: visibleCtx.weekNumber,
        seasonYear: visibleCtx.seasonYear,
    } : null
    const actionContext = readOnly ? null : actionOwner
    const lineupForActions = useMemo(
        () => visibleCtx ? { starters: visibleStarters, bench: visibleBench } : null,
        [visibleBench, visibleCtx, visibleStarters],
    )
    const reloadLineupForActions = useCallback(async (date: string) => {
        await load(date)
    }, [load])


    const {
        canRecover,
        selected,
        setSelected,
        saving,
        handleTap,
    } = useLineupActions({
        actionContext,
        actionOwner,
        myLineup: lineupForActions,
        league: currentLeague,
        selectedDate,
        startedTeams,
        reloadLineup: reloadLineupForActions,
    })
    recoverLineup.current = canRecover

    const preselectedKey = requestedPlayerId ? `${ownerKey}:${selectedDate}:${requestedPlayerId}` : null
    const preselectionPending = Boolean(preselectedKey && preselectedKeyRef.current !== preselectedKey && !readOnly && lineupForActions)
    const requestedStarterIndex = preselectionPending ? visibleStarters.findIndex((slot) => slot.player?.playerId === requestedPlayerId) : -1
    const requestedBenchIndex = preselectionPending ? visibleBench.findIndex((player) => player.playerId === requestedPlayerId) : -1
    const displayedSelection = requestedStarterIndex >= 0
        ? { kind: 'starter' as const, index: requestedStarterIndex }
        : requestedBenchIndex >= 0
            ? { kind: 'bench' as const, index: requestedBenchIndex }
            : selected

    useEffect(() => {
        if (!requestedPlayerId || readOnly || lineupLoading || lineupRefreshing || !lineupForActions) return
        const preselectedKey = `${ownerKey}:${selectedDate}:${requestedPlayerId}`
        if (preselectedKeyRef.current === preselectedKey) return
        preselectedKeyRef.current = preselectedKey
        const starterIndex = visibleStarters.findIndex((slot) => slot.player?.playerId === requestedPlayerId)
        if (starterIndex >= 0) {
            setSelected({ kind: 'starter', index: starterIndex })
            return
        }
        const benchIndex = visibleBench.findIndex((player) => player.playerId === requestedPlayerId)
        if (benchIndex >= 0) setSelected({ kind: 'bench', index: benchIndex })
    }, [lineupForActions, lineupLoading, lineupRefreshing, ownerKey, readOnly, requestedPlayerId, selectedDate, setSelected, visibleBench, visibleStarters])

    const targetState = (to: { kind: 'starter' | 'bench'; index: number }) =>
        !readOnly && lineupForActions && currentLeague
            ? getLineupMoveTargetState({
                  lineup: lineupForActions,
                  league: currentLeague,
                  startedTeams,
                  from: displayedSelection,
                  to,
              })
            : null

    const pinDisabled = readOnly || !online || saving || pinSaving || selectedDate < currentDay

    async function handlePinChange(player: LineupPlayer, pin: LineupPin) {
        if (!actionContext || pinDisabled || pinPendingRef.current || (player.nbaTeam && startedTeams.has(player.nbaTeam))) return
        const date = selectedDate
        const generation = sessionGeneration()
        const identity = ownerKey
        const isCurrent = () => activeOwnerRef.current === identity && generation === sessionGeneration()
            && readStoredAuthState().session?.user.id === userId
        pinPendingRef.current = true
        setPinSaving(true)
        setSelected(null)
        const release = holdPwaUpdate('lineup pin')
        let pinSaved = false
        try {
            await setLineupPlayerPin(actionContext.leagueId, player.playerId, date, pin)
            pinSaved = true
            if (!isCurrent()) return
            await optimizeLineupDate(actionContext.memberId, actionContext.leagueId, actionContext.seasonId, date)
            if (isCurrent()) void refreshIrNotices()
            if (isCurrent() && selectedDateRef.current === date) await load(date)
        } catch (error) {
            if (isCurrent()) {
                showAlert('Error', getErrorMessage(error))
                if (pinSaved && isCurrent() && selectedDateRef.current === date) await load(date)
            }
        } finally {
            pinPendingRef.current = false
            setPinSaving(false)
            release()
        }
    }

    async function handleDaySelect(date: string) {
        setSelectedDate(date)
        selectedDateRef.current = date
        setDataDate('')
        setStarters([])
        setBench([])
        setContextAuthority(false)
        setSavedSnapshot(true)
        setSelected(null)
        await load(date)
    }

    if (!visibleCtx) {
        const emptyMessage = lineupLoading
            ? ''
            : lineupError
              ? 'Could not load lineup.'
              : !snapshotScope && membershipValidated ? 'No active league.' : 'No active lineup yet.'
        return (
            <DeferredContent ready={!lineupLoading} fallback={<LineupFrame inline={inline}>{!inline ? <PageHeader compact title="Lineup" onBack={() => back()} backLabel="Back to lineup" showTitle /> : null}</LineupFrame>}>
            <LineupFrame inline={inline}>
                {!inline ? <PageHeader compact title="Lineup" onBack={() => back()} backLabel="Back to lineup" showTitle /> : null}
                <View style={[styles.empty, { minHeight: 320 }]} aria-busy={lineupLoading} accessibilityState={{ busy: lineupLoading }}>
                    <Text style={styles.emptyText}>{emptyMessage}</Text>
                    {lineupError ? <Text style={styles.emptySubtext}>{lineupError}</Text> : null}
                    {lineupError ? (
                        <MotionPressable
                            style={styles.retryButton}
                            onPress={() => { if (!snapshotScope) void refreshLeague(); else void load() }}
                            accessibilityRole="button"
                            accessibilityLabel="Retry lineup load"
                        >
                            <Text style={styles.retryButtonText}>Try again</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            </LineupFrame>
            </DeferredContent>
        )
    }

    const rosterEmpty = visibleStarters.every((s) => !s.player) && visibleBench.length === 0

    return (
        <DeferredContent ready={(!lineupLoading && matchingDay && gamesReady && (!preselectedKey || preselectedKeyRef.current === preselectedKey || !lineupRefreshing)) || Boolean(lineupError)}>
        <LineupFrame inline={inline}>
            {!inline ? <PageHeader
                title={`Week ${visibleCtx.weekNumber} lineup`}
                onBack={() => back()}
                backLabel="Back to lineup" showTitle
                compact
            /> : null}

            {irNotices.length > 0 ? (
                <View style={{ marginHorizontal: padX, marginTop: spacing.md }}>
                    <IrNotices notices={irNotices} />
                </View>
            ) : null}

            {weekDays.length > 0 && (
                <DaySelector timezone={currentLeague?.timezone} days={weekDays} selectedDate={selectedDate} onSelect={handleDaySelect} compact={compactDays} />
            )}

            {lineupError && online ? (
                <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerText}>{lineupError}</Text>
                    <MotionPressable
                        style={styles.errorRetryButton}
                        onPress={() => { void load(selectedDate) }}
                        accessibilityRole="button"
                        accessibilityLabel="Retry selected lineup day"
                    >
                        <Text style={styles.errorRetryButtonText}>Retry</Text>
                    </MotionPressable>
                </View>
            ) : null}

            <LineupBody inline={inline} padX={padX} twoColumn={twoColumn}>
                {rosterEmpty && matchingDay ? (
                    <View style={styles.preDraftHint}>
                        <Text style={styles.preDraftHintText}>
                            No players yet — your roster fills as you draft. Draft players to set your Week {visibleCtx.weekNumber} lineup.
                        </Text>
                    </View>
                ) : null}
                <View style={[styles.columns, twoColumn && styles.columnsWide]}>
                {visibleStarters.length > 0 ? (
                <View style={[styles.column, twoColumn && styles.columnWide]}>
                <SectionBand variant="plain" label="Starters" style={styles.firstSectionLabel} />
                <MotionView style={styles.card} preset="rise">
                    {visibleStarters.map((slot, i) => (
                        <StarterRow
                            key={`starter-${i}`}
                            slot={slot}
                            locks={locksFor(slot.player)}
                            index={i}
                            isSelected={displayedSelection?.kind === 'starter' && displayedSelection.index === i}
                            liveTeams={liveTeams}
                            startedTeams={startedTeams}
                            teamMatchups={displayedMatchups}
                            onPress={() => handleTap({ kind: 'starter', index: i })}
                            disabled={readOnly || saving || pinSaving || lineupRefreshing || lineupLoading}
                            pinDisabled={pinDisabled}
                            pinCompact={pinCompact}
                            onPinChange={handlePinChange}
                            readOnly={readOnly}
                            targetState={targetState({ kind: 'starter', index: i })}
                        />
                    ))}
                </MotionView>
                </View>

                ) : null}
                {matchingDay && Math.max(benchSlots, visibleBench.length) > 0 ? (
                <View style={[styles.column, twoColumn && styles.columnWide]}>
                <SectionBand variant="plain" label="Bench" />
                <MotionView style={styles.card} preset="rise" delay={90}>
                    {visibleBench.map((player, i) => (
                        <BenchRow
                            key={player.playerId}
                            player={player}
                            locks={locksFor(player)}
                            index={i}
                            isSelected={displayedSelection?.kind === 'bench' && displayedSelection.index === i}
                            liveTeams={liveTeams}
                            startedTeams={startedTeams}
                            teamMatchups={displayedMatchups}
                            onPress={() => handleTap({ kind: 'bench', index: i })}
                            disabled={readOnly || saving || pinSaving || lineupRefreshing || lineupLoading}
                            pinDisabled={pinDisabled}
                            pinCompact={pinCompact}
                            onPinChange={handlePinChange}
                            readOnly={readOnly}
                            targetState={targetState({ kind: 'bench', index: i })}
                        />
                    ))}
                    {Array.from({ length: Math.max(0, benchSlots - visibleBench.length) }, (_, i) => {
                        const index = visibleBench.length + i
                        const state = targetState({ kind: 'bench', index })
                        const disabled = readOnly || saving || pinSaving || lineupRefreshing || lineupLoading || state === 'invalid'
                        return (
                            <MotionPressable
                                key={`empty-${i}`}
                                style={[styles.benchRow, index > 0 && styles.divider, state === 'valid' && styles.validTargetRow]}
                                onPress={() => handleTap({ kind: 'bench', index })}
                                disabled={disabled}
                                disabledOpacity={readOnly ? 1 : undefined}
                                accessibilityRole="button"
                                accessibilityLabel="Empty bench slot"
                                accessibilityHint={state === 'valid' ? 'Move the selected player to the bench' : undefined}
                                accessibilityState={{ disabled }}
                            >
                                <Text style={styles.benchEmpty}>Empty bench slot</Text>
                            </MotionPressable>
                        )
                    })}
                </MotionView>
                </View>
                ) : null}
                </View>
                {matchingDay && ownsLineup ? ([
                    { label: 'IR', players: reserves.ir, count: limits?.irSlots ?? 0 },
                    { label: 'Taxi', players: reserves.taxi, count: limits?.taxiSlots ?? 0 },
                ].map(({ label, players, count }) => Math.max(count, players.length) > 0 ? (
                    <View key={label}>
                        <SectionBand variant="plain" label={label} />
                        <View style={styles.card}>
                            {Array.from({ length: Math.max(count, players.length) }, (_, index) => {
                                const player = players[index]
                                return (
                                    <View key={player?.playerId ?? `empty-${index}`}><View
                                        style={[styles.slotRow, index > 0 && styles.divider]}
                                        accessibilityLabel={player ? `${label} ${player.displayName}` : `Empty ${label.toLowerCase()} slot`}>
                                        <Text style={styles.slotLabel}>{label}</Text>
                                        {player ? <PlayerRowContent locks={locksFor(player)} name={player.displayName} nbaId={player.nbaId} team={player.nbaTeam}
                                            positions={player.eligiblePositions} playerId={player.playerId} yearsExp={player.yearsExp} careerGames={player.careerGames}
                                            injuryStatus={player.injuryStatus} /> : <Text style={styles.emptySlot}>Empty {label.toLowerCase()} slot</Text>}
                                    </View></View>
                                )
                            })}
                        </View>
                    </View>
                ) : null)) : null}
            </LineupBody>
            <ScreenStatusOverlay>
                {readOnly && ((!matchingDay && !lineupLoading) || !online || lineupError) ? (
                    <View style={styles.statusBanner}>
                        <Text style={styles.statusBannerText}>{!matchingDay ? 'Lineup unavailable for this day' : !online ? 'Saved lineup · Offline · Changes stay pending' : 'Saved lineup · Refresh failed · Read only'}</Text>
                    </View>
                ) : null}
            </ScreenStatusOverlay>

        </LineupFrame>
        </DeferredContent>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    preDraftHint: {
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primaryLight,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    preDraftHintText: { ...textStyles.body, color: colors.primaryDark, fontWeight: fontWeight.medium },

    statusBanner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.primaryBorder,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    statusBannerText: { ...typeScale.small, color: colors.primaryDark, fontWeight: fontWeight.medium },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: colors.dangerLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.dangerLight,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    errorBannerText: { ...typeScale.small, flex: 1, color: colors.dangerDark, fontWeight: fontWeight.medium },
    errorRetryButton: {
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorRetryButtonText: { ...typeScale.small, color: colors.dangerDark, fontWeight: fontWeight.bold },

    scroller: { flex: 1, minHeight: 0 },
    scroll: { paddingTop: spacing.none, paddingBottom: spacing.lg, gap: spacing.md, width: '100%', maxWidth: layout.lineupMaxWidth, alignSelf: 'center' },
    scrollWide: { maxWidth: 2 * layout.lineupMaxWidth },
    columns: { gap: spacing.md },
    columnsWide: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    // Only flex side by side; in one column a flex child would shrink inside the scroll view.
    column: { minWidth: 0 },
    columnWide: { flex: 1 },

    firstSectionLabel: { marginBottom: spacing.none },

    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        marginBottom: spacing.lg,
        overflow: 'hidden',
    },

    rowLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingRight: spacing.lg },
    slotRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: componentTokens.playerRow.standard.paddingVertical,
        paddingLeft: spacing.lg,
        gap: componentTokens.playerRow.standard.gap,
        minHeight: componentTokens.playerRow.lineupHeight,
    },
    benchRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: componentTokens.playerRow.standard.paddingVertical,
        paddingLeft: spacing.lg,
        gap: componentTokens.playerRow.standard.gap,
        minHeight: componentTokens.playerRow.lineupHeight,
    },
    divider: { borderTopWidth: 1, borderTopColor: colors.separator },
    selectedRow: { backgroundColor: colors.primaryLight },
    validTargetRow: { backgroundColor: colors.successLight },
    invalidTargetRow: { opacity: 0.38 },

    slotLabel: {
        ...typeScale.caption,
        width: 36,
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
    },

    pinNote: { ...textStyles.meta, color: colors.primaryDark, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
    playerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    playerName: { ...textStyles.rowTitle },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    playerMeta: { ...textStyles.meta, flexShrink: 1 },
    rowStatus: { width: controlSize.minTouch, textAlign: 'right' },

    emptySlot: { ...textStyles.body, color: colors.textMuted, fontStyle: 'italic' },
    lockedBadge: {
        ...typeScale.micro,
        fontWeight: fontWeight.bold,
        color: uiColors.successTextLive,
    },
    moveBadge: {
        ...typeScale.micro,
        fontWeight: fontWeight.extrabold,
        color: colors.successDark,
    },
    benchEmpty: { ...typeScale.small, color: colors.textPlaceholder, fontStyle: 'italic' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
    emptyText: { ...typeScale.body, color: colors.textPlaceholder },
    emptySubtext: {
        maxWidth: 320,
        marginTop: spacing.sm,
        ...textStyles.meta,
        textAlign: 'center',
    },
    retryButton: {
        minHeight: controlSize.minTouch,
        marginTop: spacing.lg,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    retryButtonText: { ...typeScale.small, color: colors.textWhite, fontWeight: fontWeight.bold },
})

export default function LineupScreenWithStatus() {
    return <ScreenStatusProvider><LineupEditor /></ScreenStatusProvider>
}
