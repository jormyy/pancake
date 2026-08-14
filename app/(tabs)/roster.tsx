import {
    View,
    Text,
    Pressable,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { FlashList, FlashListRef } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import * as Haptics from 'expo-haptics'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, toggleIR, toggleTaxi, dropPlayer, isIREligible, isTaxiEligible, RosterPlayer } from '@/lib/roster'
import { getPicksForMember, TradePickItem } from '@/lib/trades'
import { getMyWaiverClaims, cancelWaiverClaim, editWaiverClaim, reorderWaiverClaim, getMyWaiverPriority, WaiverClaim } from '@/lib/waivers'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps, RosterAverage } from '@/lib/roster-stats'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { countLabel, formatPoints, playerHeadshotUrl } from '@/lib/format'
import { RosterClaimItem, RosterPickItem, RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { Avatar } from '@/components/Avatar'
import { debounceRealtimeRefresh, reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import { RosterTrimBanner } from '@/components/roster/RosterTrimBanner'
import { activeRosterOverflow, createRosterRecoveryRunner } from '@/lib/roster-overflow'
import { AutoSetModal } from '@/components/AutoSetModal'
import { autoSetLineup, getLineupContext } from '@/lib/lineup'

type RosterListItem =
    | { _isHeader: true; _section: string }
    | { _isHeader: false; _isEmpty: true; _section: 'taxi' }
    | { _isHeader: false; _isEmpty: true; _section: 'active'; _emptyIndex: number }
    | (RosterPlayer & { _isHeader: false; _isEmpty: false; _section: 'active' | 'ir' | 'taxi' })
    | (TradePickItem & { _isHeader: false; _isEmpty: false; _section: 'picks' })
    | (WaiverClaim & { _isHeader: false; _isEmpty: false; _section: 'claims' })

const EMPTY_ROSTER: RosterPlayer[] = []
const EMPTY_PICKS: TradePickItem[] = []
const EMPTY_CLAIMS: WaiverClaim[] = []
type RosterScreenData = {
    roster: RosterPlayer[]
    picks: TradePickItem[]
    claims: WaiverClaim[]
    avgMap: Map<string, number>
    avgStatsMap: Map<string, RosterAverage>
    waiverPriority: number | null
}
type RosterScreenCache = {
    roster: RosterPlayer[]
    picks: TradePickItem[]
    claims: WaiverClaim[]
    avgEntries: [string, number][]
    avgStatsEntries: [string, RosterAverage][]
    waiverPriority: number | null
}
const ROSTER_CACHE_PREFIX = 'pancake:roster-screen:v1:'

const LINEUP_SLOT_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE'] as const

function rosterSlotRank(player: RosterPlayer): number {
    const eligible = player.players.eligible_positions?.length
        ? player.players.eligible_positions
        : player.players.position
          ? [player.players.position]
          : []
    const rank = LINEUP_SLOT_ORDER.findIndex((slot) => eligible.includes(slot))
    return rank === -1 ? LINEUP_SLOT_ORDER.length : rank
}

function compareRosterBySlot(a: RosterPlayer, b: RosterPlayer): number {
    const slotCmp = rosterSlotRank(a) - rosterSlotRank(b)
    if (slotCmp !== 0) return slotCmp
    return (a.players.display_name ?? '').localeCompare(b.players.display_name ?? '')
}

function rosterCacheKey(memberId: string, leagueId: string) {
    return `${ROSTER_CACHE_PREFIX}${leagueId}:${memberId}`
}

function readRosterCache(memberId: string | undefined, leagueId: string | undefined): RosterScreenData | undefined {
    if (!memberId || !leagueId) return undefined
    const cached = readPersistentCache<RosterScreenCache>(rosterCacheKey(memberId, leagueId))
    if (!cached) return undefined
    return {
        roster: cached.roster,
        picks: cached.picks,
        claims: cached.claims,
        avgMap: new Map(cached.avgEntries),
        avgStatsMap: new Map(cached.avgStatsEntries),
        waiverPriority: cached.waiverPriority,
    }
}

function writeRosterCache(memberId: string, leagueId: string, data: RosterScreenData) {
    writePersistentCache<RosterScreenCache>(rosterCacheKey(memberId, leagueId), {
        roster: data.roster,
        picks: data.picks,
        claims: data.claims,
        avgEntries: Array.from(data.avgMap.entries()),
        avgStatsEntries: Array.from(data.avgStatsMap.entries()),
        waiverPriority: data.waiverPriority,
    })
}

function fmtStat(value?: number | null, integer = false): string {
    if (value != null && integer) return String(Math.round(Number(value)))
    return formatPoints(value)
}

function RosterTableHeader() {
    return (
        <View style={styles.rosterTableHeader}>
            <Text style={styles.rosterTableSlot}>Slot</Text>
            <Text style={styles.rosterTablePlayer}>Player</Text>
            {['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP'].map((label) => (
                <Text key={label} style={styles.rosterTableStat}>{label}</Text>
            ))}
            <Text style={styles.rosterTableAction}>Action</Text>
        </View>
    )
}

function RosterTablePlayerItem({
    item,
    section,
    avgFpts,
    stats,
    isBusy,
    taxiSlotsAvailable,
    onPress,
    onLongPress,
    onToggleIR,
    onToggleTaxi,
}: {
    item: RosterPlayer
    section: 'active' | 'ir' | 'taxi'
    avgFpts?: number
    stats?: RosterAverage
    isBusy: boolean
    taxiSlotsAvailable: boolean
    onPress: (item: RosterPlayer) => void
    onLongPress?: (item: RosterPlayer) => void
    onToggleIR: (item: RosterPlayer) => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const positions = item.players.eligible_positions?.length
        ? item.players.eligible_positions
        : item.players.position
          ? [item.players.position]
          : []
    const slot = section === 'ir' ? 'IR' : section === 'taxi' ? 'TX' : positions[0] ?? 'BE'
    const canIR = item.is_on_ir || isIREligible(item.players.injury_status)
    const canTaxi = !item.is_on_ir && !item.is_on_taxi && taxiSlotsAvailable && isTaxiEligible(item.players)

    return (
        <View style={styles.rosterTableRow}>
            <Pressable
                style={styles.rosterTableOpen}
                onPress={() => onPress(item)}
                onLongPress={onLongPress ? () => onLongPress(item) : undefined}
                disabled={isBusy}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.players.display_name}`}
                accessibilityState={{ disabled: isBusy }}
            >
                <Text style={styles.rosterTableSlot}>{slot}</Text>
                <View style={styles.rosterTablePlayerCell}>
                    <Avatar
                        name={item.players.display_name}
                        uri={playerHeadshotUrl(item.players.nba_id) ?? undefined}
                        color={colors.bgMuted}
                        textColor={colors.textSecondary}
                        size={34}
                    />
                    <View style={styles.rosterTablePlayerInfo}>
                        <Text style={styles.rosterTableName} numberOfLines={1}>{item.players.display_name}</Text>
                        <Text style={styles.rosterTableMeta} numberOfLines={1}>
                            {[item.players.nba_team, ...positions].filter(Boolean).join(' · ')}
                        </Text>
                    </View>
                </View>
                <Text style={[styles.rosterTableStat, styles.rosterTableFp]}>{fmtStat(avgFpts)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_minutes_played)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_points)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_rebounds)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_assists)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_steals)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_blocks)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_three_pointers_made)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.avg_turnovers)}</Text>
                <Text style={styles.rosterTableStat}>{fmtStat(stats?.games_played, true)}</Text>
            </Pressable>
            <View style={styles.rosterTableActions}>
                {section === 'taxi' ? (
                    <Pressable style={styles.tableActionButton} onPress={() => onToggleTaxi(item)} disabled={isBusy}
                        accessibilityRole="button" accessibilityLabel={`Activate ${item.players.display_name}`}
                        accessibilityState={{ disabled: isBusy }}>
                        <Text style={styles.tableActionText}>Activate</Text>
                    </Pressable>
                ) : canIR ? (
                    <Pressable style={styles.tableActionButton} onPress={() => onToggleIR(item)} disabled={isBusy}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.is_on_ir ? 'Activate' : 'Move to IR'} ${item.players.display_name}`}
                        accessibilityState={{ disabled: isBusy }}>
                        <Text style={styles.tableActionText}>{item.is_on_ir ? 'Active' : 'IR'}</Text>
                    </Pressable>
                ) : canTaxi ? (
                    <Pressable style={styles.tableActionButton} onPress={() => onToggleTaxi(item)} disabled={isBusy}
                        accessibilityRole="button" accessibilityLabel={`Move ${item.players.display_name} to taxi`}
                        accessibilityState={{ disabled: isBusy }}>
                        <Text style={styles.tableActionText}>Taxi</Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    )
}


export default function RosterScreen() {
    const { push } = useRouter()
    const { width } = useWindowDimensions()
    const { user } = useAuth()
    const { current, currentLeague, loading: leagueLoading } = useLeagueContext()
    const leagueId = currentLeague?.id
    const cachedRosterData = useMemo(
        () => readRosterCache(current?.id, leagueId),
        [current?.id, leagueId],
    )
    const listRef = useRef<FlashListRef<RosterListItem>>(null)
    const [togglingId, setTogglingId] = useState<string | null>(null)
    const [taxiingId, setTaxiingId] = useState<string | null>(null)
    const [cancellingId, setCancellingId] = useState<string | null>(null)
    const [droppingId, setDroppingId] = useState<string | null>(null)
    const [autoSetVisibleRaw, setAutoSetVisible] = useState(false)
    const [autoSettingRaw, setAutoSetting] = useState(false)
    const autoSetRunningRef = useRef(false)
    const rosterRecoveryRunnerRef = useRef(createRosterRecoveryRunner())
    const ownerIdentity = current?.id && leagueId ? `${current.id}:${leagueId}` : null
    const activeOwnerRef = useRef(ownerIdentity)
    const renderedOwnerRef = useRef(ownerIdentity)
    const actionGenerationRef = useRef(0)
    activeOwnerRef.current = ownerIdentity
    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        actionGenerationRef.current += 1
    }
    const isCurrentAction = useCallback((generation: number, identity: string | null) =>
        actionGenerationRef.current === generation && activeOwnerRef.current === identity, [])
    // Effects run post-commit, so mask cross-league leakage for the one commit
    // between a league switch and the reset effect below (mirrors the
    // ownsActionState pattern in use-lineup-actions).
    const [stateOwnerIdentity, setStateOwnerIdentity] = useState(ownerIdentity)
    const ownsActionState = stateOwnerIdentity === ownerIdentity
    const autoSetVisible = ownsActionState && autoSetVisibleRaw
    const autoSetting = ownsActionState && autoSettingRaw

    useEffect(() => {
        rosterRecoveryRunnerRef.current = createRosterRecoveryRunner()
        setTogglingId(null)
        setTaxiingId(null)
        setCancellingId(null)
        setDroppingId(null)
        setAutoSetVisible(false)
        setAutoSetting(false)
        autoSetRunningRef.current = false
        setStateOwnerIdentity(ownerIdentity)
    }, [ownerIdentity])

    const { data, loading, error, refresh } = useFocusAsyncData<RosterScreenData | null>(async () => {
        if (!current || !user) return null
        if (!leagueId) return null
        const [roster, picks, claims, waiverPriority] = await Promise.all([
            getRoster(current.id, leagueId),
            getPicksForMember(current.id, leagueId),
            getMyWaiverClaims(current.id, leagueId),
            getMyWaiverPriority(current.id, leagueId),
        ])
        const { avgMap, avgStatsMap } = await getRosterStatsMaps(roster.map((r) => r.players.id), leagueId)
        const result = { roster, picks, claims, avgMap, avgStatsMap, waiverPriority }
        writeRosterCache(current.id, leagueId, result)
        return result
    }, [current?.id, user?.id, leagueId], { initialData: cachedRosterData ?? undefined, staleMs: 300_000 })

    useEffect(() => {
        if (!current?.id || !leagueId) return

        // Debounced: waiver-processing batches touch several of these tables in
        // one burst — one reload, not one per row event.
        const refreshRoster = debounceRealtimeRefresh(() => { void refresh() })
        const channel = subscribeToTableChanges(
            `roster-screen:${leagueId}:${current.id}`,
            { mode: 'fallback', watches: [
                { table: 'roster_players', filter: `member_id=eq.${current.id}` },
                { table: 'draft_picks', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_claims', filter: `member_id=eq.${current.id}` },
                { table: 'waiver_priorities', filter: `member_id=eq.${current.id}` },
                { table: 'waiver_wire_log', filter: `league_id=eq.${leagueId}` },
            ], onChange: refreshRoster.trigger },
        )

        return () => {
            refreshRoster.cancel()
            reportRealtimeCleanup('roster', unsubscribeFromTableChanges(channel))
        }
    }, [current?.id, leagueId, refresh])

    const roster = useMemo(() => data?.roster ?? EMPTY_ROSTER, [data?.roster])
    const picks = useMemo(() => data?.picks ?? EMPTY_PICKS, [data?.picks])
    const claims = useMemo(() => data?.claims ?? EMPTY_CLAIMS, [data?.claims])
    const avgMap = useMemo(() => data?.avgMap ?? EMPTY_AVG_MAP, [data?.avgMap])
    const avgStatsMap = useMemo(() => data?.avgStatsMap ?? EMPTY_STATS_MAP, [data?.avgStatsMap])
    const waiverPriority = data?.waiverPriority ?? null
    const load = refresh
    const showRosterTable = width >= 760

    const active = useMemo(() => {
        return roster
            .filter((p) => !p.is_on_ir && !p.is_on_taxi)
            .sort(compareRosterBySlot)
    }, [roster])
    const ir = useMemo(() => [...roster.filter((p) => p.is_on_ir)].sort(compareRosterBySlot), [roster])
    const taxi = useMemo(() => [...roster.filter((p) => p.is_on_taxi)].sort(compareRosterBySlot), [roster])
    const rosterSize = currentLeague?.roster_size ?? 20
    const rosterOverflow = activeRosterOverflow(active.length, rosterSize)

    const listData = useMemo<RosterListItem[]>(() => {
        const result: RosterListItem[] = []
        result.push({ _isHeader: true, _section: 'active' })
        for (const p of active) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'active' as const })
        for (let i = active.length; i < rosterSize; i++) {
            result.push({ _isHeader: false, _isEmpty: true, _section: 'active', _emptyIndex: i })
        }
        if (ir.length > 0) {
            result.push({ _isHeader: true, _section: 'ir' })
            for (const p of ir) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'ir' as const })
        }
        result.push({ _isHeader: true, _section: 'taxi' })
        if (taxi.length === 0) {
            result.push({ _isHeader: false, _isEmpty: true, _section: 'taxi' })
        } else {
            for (const p of taxi) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'taxi' as const })
        }
        result.push({ _isHeader: true, _section: 'picks' })
        for (const p of picks) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'picks' as const })
        if (claims.length > 0) {
            result.push({ _isHeader: true, _section: 'claims' })
            for (const c of claims) result.push({ ...c, _isHeader: false, _isEmpty: false, _section: 'claims' as const })
        }
        return result
    }, [active, ir, taxi, picks, claims, rosterSize])

    const claimsHeaderIndex = useMemo(
        () => listData.findIndex((item) => item._isHeader && item._section === 'claims'),
        [listData],
    )

    function scrollToClaims() {
        if (claimsHeaderIndex === -1) return
        listRef.current?.scrollToIndex({ index: claimsHeaderIndex, animated: true })
    }

    const handleToggleIR = useCallback(async (item: RosterPlayer) => {
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        const lockMessage = await getRosterStatusChangeLockMessage(item)
        if (!isCurrentAction(generation, identity)) return
        if (lockMessage) {
            showAlert('Roster locked', lockMessage)
            return
        }

        const irSlots = currentLeague?.ir_slots ?? 2
        const activeSlots = currentLeague?.roster_size ?? 20
        const name = item.players.display_name

        if (!item.is_on_ir) {
            if (!isIREligible(item.players.injury_status)) {
                showAlert('Not IR Eligible', 'Only players with Out or IR designations can be placed on IR.')
                return
            }
            const currentIR = roster.filter((p) => p.is_on_ir).length
            if (currentIR >= irSlots) {
                showAlert('IR Full', `You only have ${countLabel(irSlots, 'IR slot')}.`)
                return
            }
        } else {
            const activeCount = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi).length
            if (activeCount >= activeSlots) {
                showAlert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        const title = item.is_on_ir ? 'Activate from IR?' : 'Move to IR?'
        const message = item.is_on_ir
            ? `Move ${name} back to your active roster?`
            : `Move ${name} to the injured reserve slot?`

        confirmAction(title, message, async () => {
            if (!isCurrentAction(generation, identity)) return
            await rosterRecoveryRunnerRef.current(async () => {
                if (!isCurrentAction(generation, identity)) return
                setTogglingId(item.id)
                try {
                    await toggleIR(item.id, !item.is_on_ir)
                    if (isCurrentAction(generation, identity)) await load()
                } catch (e) {
                    if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
                } finally {
                    if (isCurrentAction(generation, identity)) setTogglingId(null)
                }
            })
        })
    }, [ownerIdentity, currentLeague, roster, load, isCurrentAction])

    const handleToggleTaxi = useCallback(async (item: RosterPlayer) => {
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        const lockMessage = await getRosterStatusChangeLockMessage(item)
        if (!isCurrentAction(generation, identity)) return
        if (lockMessage) {
            showAlert('Roster locked', lockMessage)
            return
        }

        const taxiSlots = currentLeague?.taxi_slots ?? 3
        const activeSlots = currentLeague?.roster_size ?? 20
        const name = item.players.display_name

        if (!item.is_on_taxi) {
            if (!isTaxiEligible(item.players)) {
                showAlert('Not Eligible', 'Only rookies (NBA draft picks) can be placed on the taxi squad.')
                return
            }
            const currentTaxi = roster.filter((p) => p.is_on_taxi).length
            if (currentTaxi >= taxiSlots) {
                showAlert('Taxi Full', `You only have ${countLabel(taxiSlots, 'taxi squad slot')}.`)
                return
            }
        } else {
            const activeCount = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi).length
            if (activeCount >= activeSlots) {
                showAlert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        const title = item.is_on_taxi ? 'Activate from Taxi?' : 'Move to Taxi Squad?'
        const message = item.is_on_taxi
            ? `Move ${name} to your active roster?`
            : `Move ${name} to the taxi squad?`

        confirmAction(title, message, async () => {
            if (!isCurrentAction(generation, identity)) return
            await rosterRecoveryRunnerRef.current(async () => {
                if (!isCurrentAction(generation, identity)) return
                setTaxiingId(item.id)
                try {
                    await toggleTaxi(item.id, !item.is_on_taxi)
                    if (isCurrentAction(generation, identity)) await load()
                } catch (e) {
                    if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
                } finally {
                    if (isCurrentAction(generation, identity)) setTaxiingId(null)
                }
            })
        })
    }, [ownerIdentity, currentLeague, roster, load, isCurrentAction])

    async function runAutoSet(mode: 'today' | 'week' | 'season') {
        // Ref latch: state alone can't stop a same-frame double-tap (both taps
        // read the pre-commit value).
        if (!current || !leagueId || autoSetRunningRef.current) return
        autoSetRunningRef.current = true
        setAutoSetVisible(false)
        setAutoSetting(true)
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        try {
            const ctx = await getLineupContext(leagueId)
            if (!ctx) {
                showAlert('No active season', 'Lineups open once the season starts.')
                return
            }
            const result = await autoSetLineup(
                current.id, leagueId, ctx.seasonId, ctx.weekNumber, ctx.seasonYear,
                mode === 'today' ? ctx.today : null, mode === 'season',
            )
            if (!isCurrentAction(generation, identity)) return
            if (mode === 'season' && result?.failed) {
                showAlert('Lineup partly optimized', `Optimized ${result.optimized} of ${result.dates} dates; ${result.failed} failed.`)
            } else {
                showAlert(
                    'Lineup set',
                    mode === 'today' ? 'Your best lineup is set for today.'
                        : mode === 'week' ? 'Your best lineup is set for the whole week.'
                            : 'Your best lineup is set for the rest of the season.',
                )
            }
        } catch (e) {
            if (isCurrentAction(generation, identity)) showAlert('Auto-set failed', getErrorMessage(e))
        } finally {
            autoSetRunningRef.current = false
            if (isCurrentAction(generation, identity)) setAutoSetting(false)
        }
    }

    const handleDropPrompt = useCallback((item: RosterPlayer) => {
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
        confirmAction(
            `Drop ${item.players.display_name}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                if (!isCurrentAction(generation, identity)) return
                await rosterRecoveryRunnerRef.current(async () => {
                    if (!isCurrentAction(generation, identity)) return
                    setDroppingId(item.id)
                    try {
                        await dropPlayer(item.id)
                        if (isCurrentAction(generation, identity)) await load()
                    } catch (e) {
                        if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
                    } finally {
                        if (isCurrentAction(generation, identity)) setDroppingId(null)
                    }
                })
            },
            'Drop',
        )
    }, [ownerIdentity, load, isCurrentAction])

    const handleCancelClaim = useCallback(async (claimId: string) => {
        if (!current) return
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        setCancellingId(claimId)
        try {
            await cancelWaiverClaim(claimId, current.id)
            if (isCurrentAction(generation, identity)) await load()
        } catch (e) {
            if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
        } finally {
            if (isCurrentAction(generation, identity)) setCancellingId(null)
        }
    }, [current, ownerIdentity, load, isCurrentAction])

    const handleEditClaimBid = useCallback(async (claim: WaiverClaim, bidAmount: number) => {
        if (!current) return
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        try {
            await editWaiverClaim(claim.id, current.id, {
                dropPlayerId: claim.dropPlayerId,
                bidAmount,
                claimOrder: claim.claimOrder,
            })
            if (isCurrentAction(generation, identity)) await load()
        } catch (e) {
            if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
        }
    }, [current, ownerIdentity, load, isCurrentAction])

    const handleReorderClaim = useCallback(async (claimId: string, direction: 'up' | 'down') => {
        if (!current) return
        const generation = actionGenerationRef.current
        const identity = ownerIdentity
        if (!identity) return
        try {
            await reorderWaiverClaim(claimId, current.id, direction)
            if (isCurrentAction(generation, identity)) await load()
        } catch (e) {
            if (isCurrentAction(generation, identity)) showAlert('Error', getErrorMessage(e))
        }
    }, [current, ownerIdentity, load, isCurrentAction])

    const league = currentLeague
    const taxiSlots = league?.taxi_slots ?? 3
    const trimBusyId = droppingId ?? togglingId ?? taxiingId

    const handleOpenRosterPlayer = useCallback((item: RosterPlayer) => {
        push(`/player/${item.players.id}`)
    }, [push])

    const renderRosterItem = useCallback(({ item }: { item: RosterListItem }) => {
        if (item._isHeader) {
            if (item._section === 'active') {
                return <SectionHeader label="Starters & Bench · slot order" />
            }
            if (item._section === 'taxi') {
                return (
                    <View style={styles.taxiHeader}>
                        <Text style={styles.taxiHeaderText}>Taxi Squad</Text>
                        <Text style={styles.taxiHeaderSub}>Exempt from roster limits · Cannot play in lineups</Text>
                    </View>
                )
            }
            const label =
                item._section === 'picks' ? 'Draft Picks'
                : item._section === 'claims' ? 'Waiver Claims'
                : 'IR'
            return <SectionHeader label={label} />
        }
        if (item._section === 'active' && item._isEmpty) {
            return (
                <View style={styles.emptySlot}>
                    <Text style={styles.emptySlotText}>Empty roster slot</Text>
                </View>
            )
        }
        if (item._section === 'claims') {
            return (
                <RosterClaimItem
                    claim={item as WaiverClaim}
                    cancellingId={cancellingId}
                    waiverPriority={waiverPriority}
                    waiverMode={currentLeague?.waiver_mode ?? 'rolling'}
                    onCancel={handleCancelClaim}
                    onEditBid={handleEditClaimBid}
                    onReorder={handleReorderClaim}
                />
            )
        }
        if (item._section === 'picks') {
            return (
                <RosterPickItem
                    pick={item as TradePickItem}
                    myTeamName={current?.team_name ?? ''}
                />
            )
        }
        if (item._section === 'taxi' && item._isEmpty) {
            return (
                <View style={styles.taxiEmpty}>
                    <Text style={styles.taxiEmptyText}>No players on taxi squad</Text>
                </View>
            )
        }
        if (item._section === 'taxi') {
            if (showRosterTable) {
                const taxiItem = item as RosterPlayer
                return (
                    <RosterTablePlayerItem
                        item={taxiItem}
                        section="taxi"
                        avgFpts={avgMap.get(taxiItem.players.id)}
                        stats={avgStatsMap.get(taxiItem.players.id)}
                        isBusy={taxiingId === taxiItem.id}
                        taxiSlotsAvailable={taxi.length < taxiSlots}
                        onPress={handleOpenRosterPlayer}
                        onToggleIR={handleToggleIR}
                        onToggleTaxi={handleToggleTaxi}
                    />
                )
            }
            return (
                <TaxiPlayerItem
                    item={item as RosterPlayer}
                    taxiingId={taxiingId}
                    avgFpts={avgMap.get((item as RosterPlayer).players.id)}
                    avgMinutes={avgStatsMap.get((item as RosterPlayer).players.id)?.avg_minutes_played}
                    onPress={handleOpenRosterPlayer}
                    onToggleTaxi={handleToggleTaxi}
                />
            )
        }
        const rosterItem = item as RosterPlayer
        if (showRosterTable) {
            return (
                <RosterTablePlayerItem
                    item={rosterItem}
                    section={rosterItem.is_on_ir ? 'ir' : 'active'}
                    avgFpts={avgMap.get(rosterItem.players.id)}
                    stats={avgStatsMap.get(rosterItem.players.id)}
                    isBusy={togglingId === rosterItem.id || taxiingId === rosterItem.id || droppingId === rosterItem.id}
                    taxiSlotsAvailable={taxi.length < taxiSlots}
                    onPress={handleOpenRosterPlayer}
                    onLongPress={handleDropPrompt}
                    onToggleIR={handleToggleIR}
                    onToggleTaxi={handleToggleTaxi}
                />
            )
        }
        return (
            <RosterPlayerItem
                item={rosterItem}
                togglingId={togglingId}
                taxiingId={taxiingId}
                droppingId={droppingId}
                taxiSlotsAvailable={taxi.length < taxiSlots}
                avgFpts={avgMap.get(rosterItem.players.id)}
                avgMinutes={avgStatsMap.get(rosterItem.players.id)?.avg_minutes_played}
                onPress={handleOpenRosterPlayer}
                onLongPress={handleDropPrompt}
                onToggleIR={handleToggleIR}
                onToggleTaxi={handleToggleTaxi}
            />
        )
    }, [
        showRosterTable, avgMap, avgStatsMap, taxi, taxiSlots,
        togglingId, taxiingId, droppingId, cancellingId, waiverPriority,
        currentLeague?.waiver_mode, current?.team_name, handleOpenRosterPlayer,
        handleCancelClaim, handleEditClaimBid, handleReorderClaim,
        handleToggleIR, handleToggleTaxi, handleDropPrompt,
    ])

    if (!current) {
        // No loading placeholder — stay blank until the league context is
        // known so the real screen appears fully formed without reflow.
        if (leagueLoading) {
            return <View style={styles.container} />
        }
        return <EmptyState message="Join or create a league first." />
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.flex1}>
                    <Text
                        style={styles.leagueName}
                        role="heading"
                        aria-level={2}
                        accessibilityRole="header"
                    >
                        {league?.name}
                    </Text>
                    <Text style={styles.teamName}>{current.team_name}</Text>
                    <Text style={styles.rosterCount}>
                        {active.length}/{rosterSize} active · {ir.length}/{league?.ir_slots ?? 2} IR · {taxi.length}/{taxiSlots} taxi
                    </Text>
                    {claims.length > 0 ? (
                        <Pressable
                            style={styles.claimsChip}
                            onPress={scrollToClaims}
                            accessibilityRole="button"
                            accessibilityLabel={`${claims.length} waiver claim${claims.length === 1 ? '' : 's'} pending, jump to claims`}
                        >
                            <Text style={styles.claimsChipText}>
                                {claims.length} claim{claims.length === 1 ? '' : 's'} pending
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
                {roster.length > 0 ? (
                    <Pressable
                        style={[styles.lineupButton, (rosterOverflow > 0 || autoSetting) && styles.lineupButtonDisabled]}
                        onPress={rosterOverflow > 0 || autoSetting ? undefined : () => setAutoSetVisible(true)}
                        disabled={rosterOverflow > 0 || autoSetting}
                        accessibilityRole="button"
                        accessibilityLabel={rosterOverflow > 0 ? 'Trim roster before setting lineup' : 'Set lineup automatically'}
                        accessibilityState={{ disabled: rosterOverflow > 0 || autoSetting }}
                    >
                        <Text style={[styles.lineupButtonText, (rosterOverflow > 0 || autoSetting) && styles.lineupButtonTextDisabled]}>
                            {rosterOverflow > 0 ? 'Trim Roster First' : autoSetting ? 'Setting…' : 'Set Lineup'}
                        </Text>
                    </Pressable>
                ) : null}
            </View>

            {/* Error banner */}
            {error ? (
                <ErrorBanner message="Failed to load roster. Tap to retry." onRetry={refresh} />
            ) : null}

            <RosterTrimBanner
                players={active}
                excess={rosterOverflow}
                irAvailable={ir.length < (league?.ir_slots ?? 2)}
                taxiAvailable={taxi.length < taxiSlots}
                busyId={trimBusyId}
                onDrop={handleDropPrompt}
                onMoveToIR={(player) => { void handleToggleIR(player) }}
                onMoveToTaxi={(player) => { void handleToggleTaxi(player) }}
            />

            {roster.length === 0 ? (
                loading ? null : (
                    <EmptyState
                        fullScreen={false}
                        framed
                        icon="groups"
                        message="Your roster is empty"
                        description={currentLeague?.status === 'drafting'
                            ? 'Your roster fills up as you draft — the auction is live now.'
                            : 'Players you draft, add, or acquire in a trade will show up here. Browse the player pool to get started.'}
                        actionLabel={currentLeague?.status === 'drafting' ? 'Go to Draft Room' : 'Browse Players'}
                        onAction={() => push(currentLeague?.status === 'drafting' ? '/league' : '/players')}
                    />
                )
            ) : (
                <FlashList
                    ref={listRef}
                    data={listData}
                    keyExtractor={(item) =>
                        item._isHeader ? `header-${item._section}`
                        : item._isEmpty ? `empty-${item._section}-${'_emptyIndex' in item ? item._emptyIndex : 0}`
                        : ('pickId' in item ? item.pickId : item.id)
                    }
                    ItemSeparatorComponent={ItemSeparator}
                    ListHeaderComponent={showRosterTable ? <RosterTableHeader /> : null}
                    getItemType={(item) => item._isHeader ? 'header' : item._section}
                    renderItem={renderRosterItem}
                />
            )}

            <AutoSetModal
                visible={autoSetVisible}
                onClose={() => setAutoSetVisible(false)}
                onToday={() => { void runAutoSet('today') }}
                onWholeWeek={() => { void runAutoSet('week') }}
                onRestOfSeason={() => { void runAutoSet('season') }}
                onEditManually={() => { setAutoSetVisible(false); push('/(modals)/lineup') }}
            />
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    flex1: { flex: 1 },
    rosterTableHeader: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    rosterTableRow: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        backgroundColor: colors.bgScreen,
    },
    rosterTableOpen: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
    },
    rosterTableSlot: {
        width: 46,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        textTransform: 'uppercase' as const,
    },
    rosterTablePlayer: {
        flex: 1,
        minWidth: 220,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    rosterTablePlayerCell: {
        flex: 1,
        minWidth: 220,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    rosterTablePlayerInfo: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    rosterTableName: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    rosterTableMeta: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    rosterTableStat: {
        width: 50,
        textAlign: 'right',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    rosterTableFp: {
        color: colors.primaryDark,
        fontWeight: fontWeight.extrabold,
    },
    rosterTableAction: {
        width: 86,
        textAlign: 'right',
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
    },
    rosterTableActions: {
        width: 86,
        alignItems: 'flex-end',
    },
    tableActionButton: {
        minWidth: 56,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.primary,
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        backgroundColor: colors.primaryLight,
    },
    tableActionText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
    },

    header: {
        padding: spacing['2xl'],
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        gap: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    lineupButton: {
        paddingHorizontal: 14,
        paddingVertical: spacing.md,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        marginLeft: spacing.lg,
    },
    lineupButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    lineupButtonDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    lineupButtonTextDisabled: { color: colors.textMuted },
    leagueName: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    teamName: { fontSize: fontSize.md, color: colors.textSecondary },
    rosterCount: { fontSize: fontSize['2sm'], color: colors.textPlaceholder, marginTop: spacing.xs },
    claimsChip: {
        alignSelf: 'flex-start',
        marginTop: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        backgroundColor: colors.primaryLight,
    },
    claimsChipText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
    },

    taxiHeader: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        backgroundColor: colors.infoLight,
        borderLeftWidth: 3,
        borderLeftColor: colors.info,
        gap: 2,
    },
    taxiHeaderText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.info,
        letterSpacing: 0.5,
        textTransform: 'uppercase' as const,
    },
    emptySlot: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.border,
        borderRadius: radii.md,
        marginHorizontal: spacing.md,
        marginVertical: spacing.xs,
    },
    emptySlotText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        fontStyle: 'italic',
    },
    taxiEmpty: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    taxiEmptyText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        fontStyle: 'italic',
    },
    taxiHeaderSub: {
        fontSize: fontSize.xs,
        color: colors.info,
        opacity: 0.7,
    },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
    emptyTitle: { fontSize: fontSize['2lg'], fontWeight: fontWeight.bold, color: colors.textPrimary },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
