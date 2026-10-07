import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import {
    View,
    Text,
    Pressable,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { showAlert, confirmAction } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { FlashList, FlashListRef } from '@shopify/flash-list'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import * as Haptics from 'expo-haptics'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, toggleIR, toggleTaxi, dropPlayer, isIREligible, isTaxiEligible, RosterPlayer } from '@/lib/roster'
import { getPicksForMember, TradePickItem } from '@/lib/trades'
import { getMyWaiverClaims, cancelWaiverClaim, editWaiverClaim, reorderWaiverClaim, getMyWaiverPriority, WaiverClaim } from '@/lib/waivers'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps, RosterAverage } from '@/lib/roster-stats'
import { colors, fontSize, fontWeight, layout, radii, spacing, table, textStyles } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { Button, ErrorBanner, Page, PageHeader, usePageMetrics } from '@/components/ui'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { countLabel, formatPoints, playerHeadshotUrl } from '@/lib/format'
import { RosterClaimItem, RosterPickItem, RosterPlayerItem, RosterSectionBand, TaxiPlayerItem } from '@/components/roster/RosterItems'
import { RosterPlayerSheet, type RosterSheetAction } from '@/components/roster/RosterPlayerSheet'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { Avatar } from '@/components/Avatar'
import { debounceRealtimeRefresh, reportRealtimeCleanup, subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import { RosterTrimBanner } from '@/components/roster/RosterTrimBanner'
import { activeRosterOverflow, createRosterRecoveryRunner } from '@/lib/roster-overflow'
import { AutoSetModal } from '@/components/AutoSetModal'
import { autoSetLineup, getLineupContext } from '@/lib/lineup'
import { isTradingClosed } from '@/lib/league'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'

type RosterListItem = (
    | { _isHeader: true; _section: string }
    | { _isHeader: false; _isEmpty: true; _section: 'active' | 'ir' | 'taxi'; _emptyIndex: number }
    | (RosterPlayer & { _isHeader: false; _isEmpty: false; _section: 'active' | 'ir' | 'taxi' })
    | (TradePickItem & { _isHeader: false; _isEmpty: false; _section: 'picks' })
    | (WaiverClaim & { _isHeader: false; _isEmpty: false; _section: 'claims' })
) & { _sectionEnd?: boolean }

// Each roster section renders as one card: the header opens it, the last row
// closes it. Marks the closing item so the flat list can draw the card edges.
function closeSection(items: RosterListItem[]): RosterListItem[] {
    if (items.length === 0) return items
    const last = items[items.length - 1]
    return [...items.slice(0, -1), { ...last, _sectionEnd: true }]
}

const TABLE_STATS = ['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP'] as const
const TABLE_SLOT_W = 44
const TABLE_PLAYER_MIN_W = 220
const TABLE_ACTIONS_W = 104
// Narrowest width that fits every stat column; below it rows stay two-line.
const TABLE_MIN_WIDTH = TABLE_SLOT_W + TABLE_PLAYER_MIN_W + TABLE_STATS.length * table.statColWidth + TABLE_ACTIONS_W + 2 * spacing.lg

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
        <View style={styles.rosterTableHeader} aria-hidden>
            <Text style={[styles.headerCell, styles.rosterTableSlot]}>Slot</Text>
            <Text style={[styles.headerCell, styles.rosterTablePlayer]}>Player</Text>
            {TABLE_STATS.map((label) => (
                <Text key={label} style={[styles.headerCell, styles.rosterTableStat]}>{label}</Text>
            ))}
            <View style={styles.rosterTableActions} />
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
                <Pressable
                    style={styles.moreButton}
                    onPress={() => onPress(item)}
                    disabled={isBusy}
                    accessibilityRole="button"
                    accessibilityLabel={`More actions for ${item.players.display_name}`}
                    accessibilityState={{ disabled: isBusy }}
                >
                    <MaterialIcons name="more-horiz" size={20} color={colors.textSecondary} />
                </Pressable>
            </View>
        </View>
    )
}


export default function RosterScreen() {
    const { push } = useRouter()
    const { padX, usableWidth } = usePageMetrics()
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
    const [sheetPlayerRaw, setSheetPlayer] = useState<RosterPlayer | null>(null)
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
    const sheetPlayer = ownsActionState ? sheetPlayerRaw : null
    const autoSetting = ownsActionState && autoSettingRaw

    useEffect(() => {
        rosterRecoveryRunnerRef.current = createRosterRecoveryRunner()
        setTogglingId(null)
        setTaxiingId(null)
        setCancellingId(null)
        setDroppingId(null)
        setSheetPlayer(null)
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
    // Inner width of the capped page column: the stat table needs every
    // column; the side column joins only when the table still fits beside it.
    const columnWidth = Math.min(usableWidth + 2 * padX, layout.contentMaxWidth) - 2 * padX
    const showRosterTable = columnWidth >= TABLE_MIN_WIDTH
    const twoPane = columnWidth >= TABLE_MIN_WIDTH + spacing['3xl'] + layout.railWidth
    const { openDraftRoom } = useDraftRoomLauncher(leagueId, { notifyOnError: true })

    const active = useMemo(() => {
        return roster
            .filter((p) => !p.is_on_ir && !p.is_on_taxi)
            .sort(compareRosterBySlot)
    }, [roster])
    const ir = useMemo(() => [...roster.filter((p) => p.is_on_ir)].sort(compareRosterBySlot), [roster])
    const taxi = useMemo(() => [...roster.filter((p) => p.is_on_taxi)].sort(compareRosterBySlot), [roster])
    const rosterSize = currentLeague?.roster_size ?? 20
    const irSlots = currentLeague?.ir_slots ?? 2
    const taxiSlots = currentLeague?.taxi_slots ?? 3
    const rosterOverflow = activeRosterOverflow(active.length, rosterSize)

    const listData = useMemo<RosterListItem[]>(() => {
        const activeItems: RosterListItem[] = [{ _isHeader: true, _section: 'active' }]
        for (const p of active) activeItems.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'active' as const })
        for (let i = active.length; i < rosterSize; i++) {
            activeItems.push({ _isHeader: false, _isEmpty: true, _section: 'active', _emptyIndex: i })
        }
        const result = closeSection(activeItems)
        // IR and taxi always list every slot, filled or empty, so the manager
        // can see how much room is left before an injury or a stash decision.
        const reserveSection = (section: 'ir' | 'taxi', players: RosterPlayer[], slots: number) => {
            if (slots === 0 && players.length === 0) return
            const items: RosterListItem[] = [{ _isHeader: true, _section: section }]
            for (const p of players) items.push({ ...p, _isHeader: false, _isEmpty: false, _section: section })
            for (let i = players.length; i < slots; i++) items.push({ _isHeader: false, _isEmpty: true, _section: section, _emptyIndex: i })
            result.push(...closeSection(items))
        }
        reserveSection('ir', ir, irSlots)
        reserveSection('taxi', taxi, taxiSlots)
        // Wide screens show picks and claims in the side column instead.
        if (!twoPane) {
            result.push(...closeSection([
                { _isHeader: true, _section: 'picks' },
                ...picks.map((p) => ({ ...p, _isHeader: false as const, _isEmpty: false as const, _section: 'picks' as const })),
            ]))
            if (claims.length > 0) {
                result.push(...closeSection([
                    { _isHeader: true, _section: 'claims' },
                    ...claims.map((c) => ({ ...c, _isHeader: false as const, _isEmpty: false as const, _section: 'claims' as const })),
                ]))
            }
        }
        return result
    }, [active, ir, taxi, picks, claims, rosterSize, irSlots, taxiSlots, twoPane])

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

    const trimBusyId = droppingId ?? togglingId ?? taxiingId

    const handleOpenRosterPlayer = useCallback((item: RosterPlayer) => {
        setSheetPlayer(item)
    }, [])

    const sheetActions = useMemo<RosterSheetAction[]>(() => {
        if (!sheetPlayer) return []
        const item = sheetPlayer
        const name = item.players.display_name
        // Close the sheet first so any confirmation opens over the roster.
        const run = (action: () => void) => () => {
            setSheetPlayer(null)
            action()
        }
        const actions: RosterSheetAction[] = [{
            key: 'page',
            label: 'Player page',
            icon: 'person',
            accessibilityLabel: `View ${name} player page`,
            onPress: run(() => push(`/player/${item.players.id}`)),
        }]
        if (!item.is_on_ir && !item.is_on_taxi && rosterOverflow === 0) {
            actions.push({
                key: 'lineup',
                label: 'Move in lineup',
                icon: 'swap-vert',
                accessibilityLabel: `Move ${name} in lineup`,
                onPress: run(() => push(`/(modals)/lineup?playerId=${encodeURIComponent(item.players.id)}`)),
            })
        }
        if (item.is_on_taxi) {
            actions.push({ key: 'taxi', label: 'Activate from taxi squad', icon: 'arrow-upward', onPress: run(() => { void handleToggleTaxi(item) }) })
        } else {
            if (item.is_on_ir || isIREligible(item.players.injury_status)) {
                actions.push({
                    key: 'ir',
                    label: item.is_on_ir ? 'Activate from IR' : 'Move to IR',
                    icon: 'local-hospital',
                    onPress: run(() => { void handleToggleIR(item) }),
                })
            }
            if (!item.is_on_ir && taxi.length < taxiSlots && isTaxiEligible(item.players)) {
                actions.push({ key: 'taxi', label: 'Move to taxi squad', icon: 'airport-shuttle', onPress: run(() => { void handleToggleTaxi(item) }) })
            }
        }
        if (!isTradingClosed(currentLeague)) {
            actions.push({ key: 'trade', label: 'Propose a trade', icon: 'swap-horiz', onPress: run(() => push('/(modals)/propose-trade')) })
        }
        actions.push({
            key: 'drop',
            label: 'Drop player',
            icon: 'person-remove',
            tone: 'danger',
            accessibilityLabel: `Drop ${name}`,
            onPress: run(() => handleDropPrompt(item)),
        })
        return actions
    }, [sheetPlayer, push, rosterOverflow, taxi.length, taxiSlots, currentLeague, handleToggleIR, handleToggleTaxi, handleDropPrompt])

    const renderRosterContent = useCallback((item: RosterListItem) => {
        if (item._isHeader) {
            if (item._section === 'active') {
                return (
                    <>
                        <RosterSectionBand label="Active roster" />
                        {showRosterTable ? <RosterTableHeader /> : null}
                    </>
                )
            }
            if (item._section === 'taxi') {
                return <RosterSectionBand label="Taxi squad" tone="taxi" detail={<Text style={styles.bandHint}>{taxi.length}/{taxiSlots} · off roster limit</Text>} />
            }
            if (item._section === 'ir') {
                return <RosterSectionBand label="Injured reserve" detail={<Text style={styles.bandHint}>{ir.length}/{irSlots}</Text>} />
            }
            const label = item._section === 'picks' ? 'Draft picks' : 'Waiver claims'
            return <RosterSectionBand label={label} />
        }
        if (item._isEmpty) {
            return (
                <View style={styles.emptySlot}>
                    <Text style={styles.emptySlotText}>
                        {item._section === 'ir' ? 'Empty IR slot' : item._section === 'taxi' ? 'Empty taxi slot' : 'Empty roster slot'}
                    </Text>
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
        showRosterTable, avgMap, avgStatsMap, taxi, taxiSlots, ir.length, irSlots,
        togglingId, taxiingId, droppingId, cancellingId, waiverPriority,
        currentLeague?.waiver_mode, current?.team_name, handleOpenRosterPlayer,
        handleCancelClaim, handleEditClaimBid, handleReorderClaim,
        handleToggleIR, handleToggleTaxi, handleDropPrompt,
    ])

    const renderRosterItem = useCallback(({ item }: { item: RosterListItem }) => (
        <View
            style={[
                styles.cardSlice,
                item._isHeader && styles.cardTop,
                item._sectionEnd ? styles.cardBottom : !item._isHeader && styles.rowDivider,
            ]}
        >
            {renderRosterContent(item)}
        </View>
    ), [renderRosterContent])

    if (!current) {
        // No loading placeholder — stay blank until the league context is
        // known so the real screen appears fully formed without reflow.
        if (leagueLoading) {
            return <View style={styles.container} />
        }
        return <EmptyState message="Join or create a league first." />
    }

    const lineupLocked = rosterOverflow > 0 || autoSetting
    const sideCards = (
        <>
            <View style={[styles.cardSlice, styles.cardTop, picks.length === 0 && styles.cardBottom]}>
                <RosterSectionBand label="Draft picks" />
            </View>
            {picks.map((pick, index) => (
                <View
                    key={pick.pickId}
                    style={[styles.cardSlice, index === picks.length - 1 ? styles.cardBottom : styles.rowDivider]}
                >
                    <RosterPickItem pick={pick} myTeamName={current.team_name ?? ''} />
                </View>
            ))}
            {claims.length > 0 ? (
                <>
                    <View style={[styles.cardSlice, styles.cardTop]}>
                        <RosterSectionBand label="Waiver claims" />
                    </View>
                    {claims.map((claim, index) => (
                        <View
                            key={claim.id}
                            style={[styles.cardSlice, index === claims.length - 1 ? styles.cardBottom : styles.rowDivider]}
                        >
                            <RosterClaimItem
                                claim={claim}
                                cancellingId={cancellingId}
                                waiverPriority={waiverPriority}
                                waiverMode={currentLeague?.waiver_mode ?? 'rolling'}
                                onCancel={handleCancelClaim}
                                onEditBid={handleEditClaimBid}
                                onReorder={handleReorderClaim}
                            />
                        </View>
                    ))}
                </>
            ) : null}
        </>
    )

    return (
        <Page title="Roster">
            <PageHeader
                tabs={(
                    <View style={styles.summary}>
                        <Text style={styles.summaryText}>
                            {active.length}/{rosterSize} active · {ir.length}/{irSlots} IR · {taxi.length}/{taxiSlots} taxi
                        </Text>
                        {claims.length > 0 && !twoPane ? (
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
                )}
                actions={roster.length > 0 ? (
                    <Button
                        size="sm"
                        variant={lineupLocked ? 'secondary' : 'primary'}
                        title={rosterOverflow > 0 ? 'Trim Roster First' : autoSetting ? 'Setting…' : 'Set Lineup'}
                        onPress={() => setAutoSetVisible(true)}
                        disabled={rosterOverflow > 0 || autoSetting}
                        accessibilityLabel={rosterOverflow > 0 ? 'Trim roster before setting lineup' : 'Set lineup automatically'}
                    />
                ) : null}
            />

            {error ? (
                <ErrorBanner message="Failed to load roster. Tap to retry." onRetry={refresh} />
            ) : null}

            <RosterTrimBanner
                players={active}
                excess={rosterOverflow}
                irAvailable={ir.length < irSlots}
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
                            ? 'Your roster fills up as you draft. The auction is live now.'
                            : 'Players you draft, add, or trade for show up here.'}
                        actionLabel={currentLeague?.status === 'drafting' ? 'Go to Draft Room' : 'Browse Players'}
                        onAction={() => {
                            if (currentLeague?.status === 'drafting') void openDraftRoom()
                            else push('/players')
                        }}
                    />
                )
            ) : (
                <View style={[styles.body, twoPane && styles.bodyTwoPane, { paddingHorizontal: twoPane ? padX : 0 }]}>
                    <View style={styles.main}>
                        <FlashList
                            ref={listRef}
                            data={listData}
                            keyExtractor={(item) =>
                                item._isHeader ? `header-${item._section}`
                                : item._isEmpty ? `empty-${item._section}-${'_emptyIndex' in item ? item._emptyIndex : 0}`
                                : ('pickId' in item ? item.pickId : item.id)
                            }
                            contentContainerStyle={{ ...styles.listContent, paddingHorizontal: twoPane ? 0 : padX }}
                            getItemType={(item) => item._isHeader ? 'header' : item._section}
                            renderItem={renderRosterItem}
                        />
                    </View>
                    {twoPane ? (
                        <ScrollView style={styles.rail} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
                            {sideCards}
                        </ScrollView>
                    ) : null}
                </View>
            )}

            <RosterPlayerSheet
                player={sheetPlayer}
                avgFpts={sheetPlayer ? avgMap.get(sheetPlayer.players.id) : undefined}
                stats={sheetPlayer ? avgStatsMap.get(sheetPlayer.players.id) : undefined}
                actions={sheetActions}
                onClose={() => setSheetPlayer(null)}
            />

            <AutoSetModal
                visible={autoSetVisible}
                onClose={() => setAutoSetVisible(false)}
                onToday={() => { void runAutoSet('today') }}
                onWholeWeek={() => { void runAutoSet('week') }}
                onRestOfSeason={() => { void runAutoSet('season') }}
                onEditManually={() => { setAutoSetVisible(false); push('/(modals)/lineup') }}
            />
        </Page>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    summary: {
        minHeight: 48,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        alignContent: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
    },
    summaryText: { ...textStyles.meta, fontWeight: fontWeight.semibold, fontVariant: ['tabular-nums'] as const },
    claimsChip: {
        minHeight: 32,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        backgroundColor: colors.primaryLight,
    },
    claimsChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.primaryDark },

    body: { flex: 1, minHeight: 0 },
    bodyTwoPane: { flexDirection: 'row', gap: spacing['3xl'] },
    main: { flex: 1, minWidth: 0, minHeight: 0 },
    rail: { width: layout.railWidth, flexGrow: 0, flexShrink: 0 },
    listContent: { paddingTop: spacing.md, paddingBottom: spacing['3xl'] },

    // One card per roster section, drawn across the flat list's items.
    cardSlice: {
        backgroundColor: colors.bgCard,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderColor: colors.borderLight,
    },
    cardTop: {
        borderTopWidth: 1,
        borderTopLeftRadius: radii.xl,
        borderTopRightRadius: radii.xl,
        overflow: 'hidden',
    },
    cardBottom: {
        borderBottomWidth: 1,
        borderBottomLeftRadius: radii.xl,
        borderBottomRightRadius: radii.xl,
        marginBottom: spacing.md,
        overflow: 'hidden',
    },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    bandHint: { ...textStyles.meta, color: colors.info },

    rosterTableHeader: {
        minHeight: table.headerHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        borderBottomWidth: 1,
        borderColor: colors.separator,
    },
    headerCell: { ...textStyles.tableHeader },
    rosterTableRow: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
    },
    rosterTableOpen: {
        flex: 1,
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
    },
    rosterTableSlot: {
        width: TABLE_SLOT_W,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        textTransform: 'uppercase' as const,
    },
    rosterTablePlayer: { flex: 1, minWidth: TABLE_PLAYER_MIN_W },
    rosterTablePlayerCell: {
        flex: 1,
        minWidth: TABLE_PLAYER_MIN_W,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    rosterTablePlayerInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    rosterTableName: { ...textStyles.rowTitle },
    rosterTableMeta: { ...textStyles.meta },
    rosterTableStat: {
        ...textStyles.tableCell,
        width: table.statColWidth,
        textAlign: 'right',
    },
    rosterTableFp: { color: colors.primaryDark, fontWeight: fontWeight.extrabold },
    rosterTableActions: {
        width: TABLE_ACTIONS_W,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: spacing.xs,
    },
    tableActionButton: {
        minWidth: 52,
        minHeight: 32,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.primaryLight,
    },
    tableActionText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.primaryDark },
    moreButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
    },

    emptySlot: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    emptySlotText: { ...textStyles.meta, color: colors.textPlaceholder, fontStyle: 'italic' },
    taxiEmpty: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    taxiEmptyText: { ...textStyles.meta, color: colors.textPlaceholder, fontStyle: 'italic' },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
