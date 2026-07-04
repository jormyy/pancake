import {
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { ItemSeparator } from '@/components/ItemSeparator'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { FilterSelect, MultiSelect } from '@/components/ui'
import { playerListStyles as styles } from '@/components/ui/playerListStyles'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { NBA_TEAM_OPTIONS } from '@/constants/nba'
import { useLeagueContext } from '@/contexts/league-context'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { todayET } from '@/lib/shared/dates'
import { type OwnedEntry } from '@/lib/roster'
import { getPlayerAvailabilitySnapshot } from '@/lib/player-availability'
import {
    getLeagueProjections,
    projectionViewLabel,
    type LeagueProjectionRow,
    type ProjectionView,
} from '@/lib/projections'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import type { PlayerRow } from '@/lib/players'
import {
    STAT_COLUMN_SORT,
    type PlayerSearchSortDir,
    type PlayerSearchSortMode,
} from '@/lib/player-search-sort'
import type {
    PlayerAvailabilityFilter,
    PlayerPlayingFilter,
    PlayerSearchHealthFilter,
} from '@/lib/player-search-state'

const POSITIONS = [
    { key: 'ALL', label: 'All' },
    { key: 'PG', label: 'PG' },
    { key: 'SG', label: 'SG' },
    { key: 'SF', label: 'SF' },
    { key: 'PF', label: 'PF' },
    { key: 'C', label: 'C' },
    { key: 'G', label: 'G' },
    { key: 'F', label: 'F' },
] as const
const VIEW_OPTIONS = [
    { key: 'today', label: 'Today' },
    { key: 'week_avg', label: 'Week Avg' },
    { key: 'week_total', label: 'Week Total' },
] satisfies readonly { key: ProjectionView; label: string }[]
const AVAILABILITY_FILTERS = [
    { key: 'all', label: 'All players' },
    { key: 'free_agents', label: 'Free agents' },
    { key: 'waivers', label: 'On waivers' },
    { key: 'rostered', label: 'Rostered' },
    { key: 'mine', label: 'My team' },
] as const
const HEALTH_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'healthy', label: 'Healthy' },
    { key: 'gtd', label: 'Game-time' },
    { key: 'out', label: 'Out' },
    { key: 'ir', label: 'IR' },
] as const
const PLAYING_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'today', label: 'Playing today' },
    { key: 'not_today', label: 'Not playing' },
] as const
const SORT_OPTIONS = [
    { key: 'fpts', label: 'Fantasy Pts' },
    { key: 'pts', label: 'Points' },
    { key: 'reb', label: 'Rebounds' },
    { key: 'ast', label: 'Assists' },
    { key: 'stl', label: 'Steals' },
    { key: 'blk', label: 'Blocks' },
    { key: 'tpm', label: '3-Pointers' },
    { key: 'to', label: 'Turnovers' },
    { key: 'gp', label: 'Games Played' },
] satisfies readonly { key: PlayerSearchSortMode; label: string }[]
const TABLE_COLUMNS = ['FP', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']
const STAT_LABELS: Record<string, string> = {
    FP: 'Fantasy points', PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals',
    BLK: 'Blocks', '3PM': 'Three-pointers made', TO: 'Turnovers', GP: 'Games played',
}

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()
const EMPTY_GAMES_LEFT = new Map<string, number>()
const PROJECTION_CACHE_PREFIX = 'pancake:league-projections:v1:'

const projectionCacheKey = (leagueId: string, view: ProjectionView) => `${PROJECTION_CACHE_PREFIX}${leagueId}:${view}`

export default function ProjectionsScreen() {
    const { push } = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const showStatTable = width >= 1180
    const collapsibleFilters = width < 780
    const [filtersOpen, setFiltersOpen] = useState(false)
    const filtersVisible = !collapsibleFilters || filtersOpen
    const [query, setQuery] = useState('')
    const [view, setView] = useState<ProjectionView>('today')
    const [availabilityFilter, setAvailabilityFilter] = useState<PlayerAvailabilityFilter>('all')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [health, setHealth] = useState<PlayerSearchHealthFilter>('all')
    const [playingFilter, setPlayingFilter] = useState<PlayerPlayingFilter>('all')
    const [sortMode, setSortMode] = useState<PlayerSearchSortMode>('fpts')
    const [sortDir, setSortDir] = useState<PlayerSearchSortDir>('desc')
    const [rows, setRows] = useState<LeagueProjectionRow[]>([])
    const [hydrated, setHydrated] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const projectionLoadSeqRef = useRef(0)

    const {
        data: ownedData,
        refresh: refreshOwned,
    } = useFocusAsyncData(async () => {
        if (!leagueId) return { leagueId: null, ownedMap: EMPTY_OWNED_MAP, waiverIds: EMPTY_WAIVER_IDS }
        return getPlayerAvailabilitySnapshot(leagueId)
    }, [leagueId])

    const ownedDataForLeague = ownedData?.leagueId === leagueId ? ownedData : null
    const ownedMap = ownedDataForLeague?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = ownedDataForLeague?.waiverIds ?? EMPTY_WAIVER_IDS
    const quickAdd = useQuickAdd(
        current?.id,
        leagueId,
        currentLeague?.roster_size ?? 20,
        waiverIds,
        refreshOwned,
    )

    async function load(nextView = view) {
        const requestId = ++projectionLoadSeqRef.current
        if (!leagueId) {
            setRows([])
            setHydrated(true)
            return
        }
        setError(null)
        const cacheKey = projectionCacheKey(leagueId, nextView)
        const cached = readPersistentCache<LeagueProjectionRow[]>(cacheKey)
        if (cached) {
            if (projectionLoadSeqRef.current !== requestId) return
            setRows(cached)
            setHydrated(true)
        } else if (rows.length === 0) {
            setHydrated(false)
        }
        try {
            const projections = await getLeagueProjections({ leagueId, view: nextView, limit: 1000 })
            if (projectionLoadSeqRef.current !== requestId) return
            setRows(projections)
            setHydrated(true)
            writePersistentCache(cacheKey, projections)
        } catch (e) {
            if (projectionLoadSeqRef.current !== requestId) return
            setError(e instanceof Error ? e.message : String(e))
            setHydrated(true)
        }
    }

    useEffect(() => {
        load(view)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [leagueId, view])

    const filteredRows = useMemo(() => {
        const search = query.trim().toLocaleLowerCase()
        const today = todayET()
        return rows
            .filter((row) => {
                const owned = ownedMap.get(row.player_id)
                if (search) {
                    const searchable = [row.display_name, row.nba_team, row.position, ...(row.eligible_positions ?? [])]
                        .filter(Boolean)
                        .join(' ')
                        .toLocaleLowerCase()
                    if (!searchable.includes(search)) return false
                }
                if (availabilityFilter === 'free_agents' && (owned || waiverIds.has(row.player_id))) return false
                if (availabilityFilter === 'waivers' && (owned || !waiverIds.has(row.player_id))) return false
                if (availabilityFilter === 'rostered' && !owned) return false
                if (availabilityFilter === 'mine' && owned?.memberId !== current?.id) return false
                if (position !== 'ALL') {
                    const positions = row.eligible_positions?.length ? row.eligible_positions : row.position ? [row.position] : []
                    if (position === 'G' && !positions.some((pos) => pos === 'PG' || pos === 'SG')) return false
                    else if (position === 'F' && !positions.some((pos) => pos === 'SF' || pos === 'PF')) return false
                    else if (position !== 'G' && position !== 'F' && !positions.includes(position)) return false
                }
                if (selectedTeams.length > 0 && (!row.nba_team || !selectedTeams.includes(row.nba_team))) return false
                if (!matchesHealth(row.injury_status, health)) return false

                const projectedDate = row.projection_date ?? row.next_game_date
                const playsToday = projectedDate === today
                if (playingFilter === 'today' && !playsToday) return false
                if (playingFilter === 'not_today' && playsToday) return false
                return true
            })
            .sort((a, b) => compareProjectionRows(a, b, sortMode, sortDir))
    }, [
        availabilityFilter,
        current?.id,
        health,
        ownedMap,
        playingFilter,
        position,
        query,
        rows,
        selectedTeams,
        sortDir,
        sortMode,
        waiverIds,
    ])

    const playerRows = useMemo(() => filteredRows.map(toPlayerRow), [filteredRows])
    const weekTotalsEmpty = useMemo(
        () => view === 'week_total' && rows.length > 0 && rows.every((row) => !row.projection_games_played),
        [rows, view],
    )
    const activeFilterCount = useMemo(() => {
        let count = 0
        if (query.trim()) count++
        if (view !== 'today') count++
        if (availabilityFilter !== 'all') count++
        if (position !== 'ALL') count++
        if (selectedTeams.length > 0) count++
        if (health !== 'all') count++
        if (playingFilter !== 'all') count++
        if (sortMode !== 'fpts') count++
        return count
    }, [availabilityFilter, health, playingFilter, position, query, selectedTeams.length, sortMode, view])

    const clearAllFilters = () => {
        setQuery('')
        setView('today')
        setAvailabilityFilter('all')
        setPosition('ALL')
        setSelectedTeams([])
        setHealth('all')
        setPlayingFilter('all')
        setSortMode('fpts')
        setSortDir('desc')
    }

    const handleColumnSort = (mode: PlayerSearchSortMode) => {
        if (sortMode === mode) {
            setSortDir((dir) => dir === 'asc' ? 'desc' : 'asc')
        } else {
            setSortMode(mode)
            setSortDir('desc')
        }
    }

    const playerListExtraData = [
        view,
        sortMode,
        sortDir,
        availabilityFilter,
        playingFilter,
        health,
        selectedTeams.join(','),
    ].join('|')

    if (!leagueId) {
        return (
            <SafeAreaView style={styles.container}>
                <EmptyState message="Join or create a league to see projections." />
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container}>
          <View style={styles.contentWrap}>
            {/* Visually hidden h1: the screen has no visible title, but web
                a11y still needs a page heading anchoring the outline. */}
            <Text style={styles.hiddenHeading} role="heading" aria-level={1} accessibilityRole="header">
                Projections
            </Text>
            <View style={styles.filterCard}>
                <View style={styles.filterCardTop}>
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Search players..."
                        placeholderTextColor={colors.textPlaceholder}
                        value={query}
                        onChangeText={setQuery}
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                    />
                    <Text style={styles.resultCountText}>
                        {!hydrated && playerRows.length === 0
                            ? 'Players'
                            : `${playerRows.length}${activeFilterCount > 0 ? ' filtered' : ''} player${playerRows.length === 1 ? '' : 's'}`}
                    </Text>
                </View>
                <View style={styles.filterCardHeader}>
                    {collapsibleFilters ? (
                        <Pressable
                            style={styles.filterToggle}
                            onPress={() => setFiltersOpen((value) => !value)}
                            accessibilityRole="button"
                            accessibilityLabel={`${filtersOpen ? 'Hide' : 'Show'} filters`}
                            accessibilityState={{ expanded: filtersOpen }}
                        >
                            <Text style={styles.filterCardTitle}>Filters</Text>
                            {activeFilterCount > 0 ? (
                                <View style={styles.filterCountDot}>
                                    <Text style={styles.filterCountDotText}>{activeFilterCount}</Text>
                                </View>
                            ) : null}
                            <Text style={styles.filterSelectCaret}>{filtersOpen ? '▴' : '▾'}</Text>
                        </Pressable>
                    ) : (
                        <Text style={styles.filterCardTitle} role="heading" aria-level={2}>Filters</Text>
                    )}
                    {activeFilterCount > 0 ? (
                        <Pressable style={styles.clearAllChip} onPress={clearAllFilters}>
                            <Text style={styles.clearAllChipText}>Clear all ({activeFilterCount})</Text>
                        </Pressable>
                    ) : null}
                </View>
                {filtersVisible ? (
                <View style={styles.filterGrid}>
                    <FilterSelect
                        label="Projection"
                        value={view}
                        options={VIEW_OPTIONS}
                        onChange={setView}
                    />
                    <FilterSelect
                        label="Availability"
                        value={availabilityFilter}
                        options={AVAILABILITY_FILTERS}
                        onChange={setAvailabilityFilter}
                    />
                    <FilterSelect
                        label="Position"
                        value={position}
                        options={POSITIONS}
                        onChange={setPosition}
                    />
                    <MultiSelect
                        label="Pro team"
                        options={NBA_TEAM_OPTIONS}
                        selected={selectedTeams}
                        onChange={setSelectedTeams}
                        pluralLabel="teams"
                        clearAccessibilityLabel="Clear teams"
                    />
                    <FilterSelect
                        label="Health"
                        value={health}
                        options={HEALTH_FILTERS}
                        onChange={setHealth}
                    />
                    <FilterSelect
                        label="Game today"
                        value={playingFilter}
                        options={PLAYING_FILTERS}
                        onChange={setPlayingFilter}
                    />
                    <FilterSelect
                        label="Sort"
                        value={sortMode}
                        options={SORT_OPTIONS}
                        onChange={(value) => {
                            setSortMode(value)
                            setSortDir('desc')
                        }}
                    />
                    <Pressable
                        style={styles.sortDirButton}
                        onPress={() => setSortDir((dir) => dir === 'asc' ? 'desc' : 'asc')}
                    >
                        <Text style={styles.sortDirText}>{sortDir === 'asc' ? 'Ascending ↑' : 'Descending ↓'}</Text>
                    </Pressable>
                </View>
                ) : null}
            </View>

            {error ? (
                <View style={localStyles.errorBox}>
                    <Text style={localStyles.errorText}>{error}</Text>
                </View>
            ) : null}

            {weekTotalsEmpty ? (
                <View style={localStyles.noticeBox}>
                    <Text style={localStyles.noticeText}>
                        No NBA games are scheduled in this week&apos;s range, so weekly totals are 0.
                        Switch to Today or Week Avg for per-game projections.
                    </Text>
                </View>
            ) : null}

            <FlashList
                data={playerRows}
                extraData={playerListExtraData}
                keyExtractor={(player) => player.id}
                contentContainerStyle={playerRows.length === 0 ? styles.emptyContainer : undefined}
                ItemSeparatorComponent={ItemSeparator}
                ListHeaderComponent={showStatTable && playerRows.length > 0 ? (
                    <View style={styles.tableHeader}>
                        <View style={styles.tableHeaderAddSpacer} />
                        <View style={styles.tableHeaderCardRow}>
                            <View style={styles.tableHeaderHeadshotSpacer} />
                            <Text style={styles.tableHeaderPlayer}>Player</Text>
                            <Text style={styles.tableHeaderOwnership}>Ownership</Text>
                            <View style={styles.tableHeaderStatsGroup}>
                                {TABLE_COLUMNS.map((column) => {
                                    const mode = STAT_COLUMN_SORT[column]
                                    const active = mode != null && sortMode === mode
                                    return (
                                        <Pressable
                                            key={column}
                                            style={styles.tableHeaderStatBtn}
                                            onPress={() => mode && handleColumnSort(mode)}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: active }}
                                            accessibilityLabel={`Sort by ${STAT_LABELS[column] ?? column}${active ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}
                                        >
                                            <Text style={[styles.tableHeaderStat, active && styles.tableHeaderStatActive]} numberOfLines={1}>
                                                {column}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                    </View>
                ) : null}
                renderItem={({ item }: { item: PlayerRow }) => (
                    <PlayerSearchItem
                        item={item}
                        currentMemberId={current?.id}
                        ownedMap={ownedMap}
                        waiverIds={waiverIds}
                        adding={quickAdd.adding}
                        gamesLeft={EMPTY_GAMES_LEFT}
                        showStats={showStatTable}
                        statMode="projection"
                        animate={false}
                        onAdd={(player) => {
                            if (waiverIds.has(player.id)) {
                                push(`/(modals)/claim-player?playerId=${player.id}`)
                            } else {
                                void quickAdd.handleAdd(player)
                            }
                        }}
                        onPress={() => push(`/player/${item.id}`)}
                    />
                )}
                ListEmptyComponent={hydrated ? <EmptyState message="No projections found." fullScreen={false} /> : null}
            />
          </View>

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
                activeRoster={(quickAdd.irModal?.roster ?? []).filter((player) => !player.is_on_ir && !player.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={quickAdd.irModal?.pendingPlayer.display_name ?? ''}
                onActivate={quickAdd.handleIRActivate}
                onDropAndActivate={quickAdd.handleDropAndIRActivate}
                onCancel={() => quickAdd.setIrModal(null)}
            />
        </SafeAreaView>
    )
}

function toPlayerRow(row: LeagueProjectionRow): PlayerRow {
    return {
        id: row.player_id,
        display_name: row.display_name,
        nba_team: row.nba_team,
        position: row.position,
        eligible_positions: row.eligible_positions,
        status: null,
        injury_status: row.injury_status,
        headshot_url: row.headshot_url,
        nba_id: row.nba_id,
        years_exp: null,
        projection_fantasy_points: row.projection_fantasy_points,
        projection_source: row.projection_source,
        projection_source_label: row.projection_source_label ?? projectionViewLabel(row.projection_view),
        projection_view: row.projection_view,
        projection_fetched_at: row.projection_fetched_at,
        projection_date: row.projection_date,
        projection_opponent: row.next_game_opponent,
        projection_minutes: row.projection_minutes,
        projection_points: row.projection_points,
        projection_rebounds: row.projection_rebounds,
        projection_assists: row.projection_assists,
        projection_steals: row.projection_steals,
        projection_blocks: row.projection_blocks,
        projection_three_pointers_made: row.projection_three_pointers_made,
        projection_turnovers: row.projection_turnovers,
        projection_games_played: row.projection_games_played,
        projection_status: row.projection_status,
    }
}

function compareProjectionRows(
    a: LeagueProjectionRow,
    b: LeagueProjectionRow,
    mode: PlayerSearchSortMode,
    dir: PlayerSearchSortDir,
): number {
    const cmp = projectionStatValue(a, mode) - projectionStatValue(b, mode)
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    return a.display_name.localeCompare(b.display_name)
}

function projectionStatValue(row: LeagueProjectionRow, mode: PlayerSearchSortMode): number {
    switch (mode) {
        case 'fpts': return row.projection_fantasy_points ?? 0
        case 'pts': return row.projection_points ?? 0
        case 'reb': return row.projection_rebounds ?? 0
        case 'ast': return row.projection_assists ?? 0
        case 'stl': return row.projection_steals ?? 0
        case 'blk': return row.projection_blocks ?? 0
        case 'tpm': return row.projection_three_pointers_made ?? 0
        case 'to': return row.projection_turnovers ?? 0
        case 'gp': return row.projection_games_played ?? 0
    }
}

function matchesHealth(injuryStatus: string | null, filter: PlayerSearchHealthFilter): boolean {
    switch (filter) {
        case 'healthy': return injuryStatus == null
        case 'gtd': return ['GTD', 'DTD', 'Questionable', 'Game Time Decision'].includes(injuryStatus ?? '')
        case 'out': return ['Out', 'OUT', 'O'].includes(injuryStatus ?? '')
        case 'ir': return ['IR', 'IR-LTI'].includes(injuryStatus ?? '')
        default: return true
    }
}

const localStyles = StyleSheet.create({
    errorBox: {
        marginHorizontal: spacing.xl,
        borderWidth: 1,
        borderColor: colors.dangerLight,
        backgroundColor: colors.dangerLight,
        padding: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous',
    },
    errorText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    noticeBox: {
        marginHorizontal: spacing.xl,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: colors.warningLight,
        backgroundColor: colors.bgMuted,
        padding: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous',
    },
    noticeText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
})
