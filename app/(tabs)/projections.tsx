import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { FlashList } from '@shopify/flash-list'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    View,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { EmptyState } from '@/components/EmptyState'
import { ItemSeparator } from '@/components/ItemSeparator'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { Chip } from '@/components/ui/Chip'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { getPositionColor } from '@/constants/positions'
import { useLeagueContext } from '@/contexts/league-context'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getOwnedPlayerMap, type OwnedEntry } from '@/lib/roster'
import { getWaiverPlayerIds } from '@/lib/waivers'
import {
    compactProjectionStatLine,
    formatProjectionGame,
    getLeagueProjections,
    numberOrDash,
    projectionFreshnessLabel,
    type LeagueProjectionRow,
    type ProjectionView,
} from '@/lib/projections'

const VIEW_OPTIONS = [
    { label: 'Today', value: 'today' },
    { label: 'Week Avg', value: 'week_avg' },
    { label: 'Week Total', value: 'week_total' },
] satisfies { label: string; value: ProjectionView }[]

const SCOPE_OPTIONS = [
    { key: 'all', label: 'All Players' },
    { key: 'mine', label: 'My Roster' },
    { key: 'available', label: 'Available' },
] as const

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'] as const
type ProjectionScope = typeof SCOPE_OPTIONS[number]['key']

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()

export default function ProjectionsScreen() {
    const router = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const [view, setView] = useState<ProjectionView>('today')
    const [scope, setScope] = useState<ProjectionScope>('all')
    const [position, setPosition] = useState<typeof POSITIONS[number]>('ALL')
    const [rows, setRows] = useState<LeagueProjectionRow[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const { data: ownership } = useFocusAsyncData(async () => {
        if (!leagueId) return { ownedMap: EMPTY_OWNED_MAP, waiverIds: EMPTY_WAIVER_IDS }
        const [ownedMap, waiverIds] = await Promise.all([
            getOwnedPlayerMap(leagueId),
            getWaiverPlayerIds(leagueId),
        ])
        return { ownedMap, waiverIds }
    }, [leagueId])

    const ownedMap = ownership?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = ownership?.waiverIds ?? EMPTY_WAIVER_IDS

    async function load(nextView = view) {
        if (!leagueId) {
            setRows([])
            setLoading(false)
            return
        }
        setError(null)
        setRefreshing(true)
        try {
            const projections = await getLeagueProjections({ leagueId, view: nextView, limit: 800 })
            setRows(projections)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }

    useEffect(() => {
        setLoading(true)
        load(view)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [leagueId, view])

    const filteredRows = useMemo(() => {
        return rows.filter((row) => {
            const owned = ownedMap.get(row.player_id)
            if (scope === 'mine' && owned?.memberId !== current?.id) return false
            if (scope === 'available' && (owned || waiverIds.has(row.player_id))) return false
            if (position !== 'ALL') {
                const positions = row.eligible_positions?.length ? row.eligible_positions : row.position ? [row.position] : []
                if (position === 'G' && !positions.some((pos) => pos === 'PG' || pos === 'SG')) return false
                else if (position === 'F' && !positions.some((pos) => pos === 'SF' || pos === 'PF')) return false
                else if (position !== 'G' && position !== 'F' && !positions.includes(position)) return false
            }
            return true
        })
    }, [current?.id, ownedMap, position, rows, scope, waiverIds])

    const fallbackCount = useMemo(
        () => filteredRows.filter((row) => view === 'today' && row.projection_source !== 'fantasypros_daily').length,
        [filteredRows, view],
    )
    const compact = width < 720

    if (!leagueId) {
        return (
            <SafeAreaView style={styles.container}>
                <EmptyState message="Join or create a league to see projections." />
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                <View style={styles.header}>
                    <View>
                        <Text style={styles.title}>Projections</Text>
                        <Text style={styles.subtitle} numberOfLines={2}>
                            {filteredRows.length} player{filteredRows.length === 1 ? '' : 's'}
                            {fallbackCount > 0 ? ` · ${fallbackCount} using fallback source` : ''}
                        </Text>
                    </View>
                    <Pressable
                        style={styles.refreshButton}
                        onPress={() => load()}
                        disabled={refreshing}
                        accessibilityRole="button"
                        accessibilityLabel="Refresh projections"
                        accessibilityState={{ busy: refreshing, disabled: refreshing }}
                    >
                        {refreshing ? (
                            <ActivityIndicator size="small" color={colors.primaryDark} />
                        ) : (
                            <MaterialIcons name="refresh" size={20} color={colors.primaryDark} />
                        )}
                    </Pressable>
                </View>

                <View style={styles.controls}>
                    <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={setView} scrollable />
                    <View style={styles.chipRow}>
                        {SCOPE_OPTIONS.map((option) => (
                            <Chip
                                key={option.key}
                                label={option.label}
                                selected={scope === option.key}
                                onPress={() => setScope(option.key)}
                            />
                        ))}
                    </View>
                    <View style={styles.chipRow}>
                        {POSITIONS.map((pos) => (
                            <Chip
                                key={pos}
                                label={pos === 'ALL' ? 'All Pos' : pos}
                                selected={position === pos}
                                onPress={() => setPosition(pos)}
                            />
                        ))}
                    </View>
                </View>

                {error ? (
                    <View style={styles.errorBox}>
                        <Text style={styles.errorText}>{error}</Text>
                    </View>
                ) : null}

                {loading ? (
                    <ActivityIndicator style={styles.loader} color={colors.primary} />
                ) : (
                    <FlashList
                        data={filteredRows}
                        keyExtractor={(row) => row.player_id}
                        ItemSeparatorComponent={ItemSeparator}
                        contentContainerStyle={filteredRows.length === 0 ? styles.emptyContainer : undefined}
                        renderItem={({ item }) => (
                            <ProjectionRow
                                row={item}
                                owned={ownedMap.get(item.player_id)}
                                isMine={ownedMap.get(item.player_id)?.memberId === current?.id}
                                compact={compact}
                                onPress={() => router.push(`/player/${item.player_id}`)}
                            />
                        )}
                        ListEmptyComponent={<EmptyState message="No projections match these filters." fullScreen={false} />}
                    />
                )}
            </View>
        </SafeAreaView>
    )
}

function ProjectionRow({
    row,
    owned,
    isMine,
    compact,
    onPress,
}: {
    row: LeagueProjectionRow
    owned?: OwnedEntry
    isMine: boolean
    compact: boolean
    onPress: () => void
}) {
    const positions = row.eligible_positions?.length ? row.eligible_positions : row.position ? [row.position] : []
    const statLine = compactProjectionStatLine(row)
    const game = formatProjectionGame(row)
    const freshness = projectionFreshnessLabel(row.projection_fetched_at)

    return (
        <Pressable
            style={[styles.row, compact && styles.rowCompact]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Open ${row.display_name}`}
        >
            <Avatar name={row.display_name} color={getPositionColor(positions[0] ?? row.position)} size={compact ? 38 : 44} />
            <View style={styles.rowMain}>
                <View style={styles.nameLine}>
                    <Text style={styles.name} numberOfLines={1}>{row.display_name}</Text>
                    {row.nba_team ? <Text style={styles.team}>{row.nba_team}</Text> : null}
                    {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                    {row.injury_status ? (
                        <Badge
                            label={row.injury_status}
                            color={INJURY_COLORS[row.injury_status] ?? colors.textMuted}
                            variant="solid"
                        />
                    ) : null}
                </View>
                <View style={styles.metaLine}>
                    {game ? <Text style={styles.metaText} numberOfLines={1}>{game}</Text> : null}
                    {row.projection_minutes != null ? <Text style={styles.metaText}>{numberOrDash(row.projection_minutes)}m</Text> : null}
                    <Text style={styles.sourceText} numberOfLines={1}>
                        {row.projection_source_label}{freshness ? ` ${freshness}` : ''}
                    </Text>
                    {owned ? <Text style={styles.ownedText} numberOfLines={1}>{isMine ? 'Mine' : owned.teamName}</Text> : null}
                </View>
                {statLine ? <Text style={styles.statLine} numberOfLines={compact ? 2 : 1}>{statLine}</Text> : null}
            </View>
            <View style={styles.pointsBox}>
                <Text style={styles.points}>{numberOrDash(row.projection_fantasy_points)}</Text>
                <Text style={styles.pointsLabel}>FP</Text>
            </View>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    content: { flex: 1, width: '100%', maxWidth: 1180, alignSelf: 'center', padding: spacing['2xl'], gap: spacing.xl },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.lg },
    title: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    subtitle: { marginTop: spacing.xs, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    refreshButton: {
        width: 40,
        height: 40,
        borderRadius: radii.md,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    controls: { gap: spacing.md },
    chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
    errorBox: {
        borderWidth: 1,
        borderColor: colors.dangerLight,
        backgroundColor: colors.dangerLight,
        padding: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous',
    },
    errorText: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
    loader: { marginTop: spacing['5xl'] },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md,
    },
    rowCompact: { alignItems: 'flex-start' },
    rowMain: { flex: 1, minWidth: 0, gap: spacing.xs },
    nameLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
    name: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary, maxWidth: '100%' },
    team: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    metaLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
    metaText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    sourceText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    ownedText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.primaryDark },
    statLine: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    pointsBox: { minWidth: 74, alignItems: 'flex-end' },
    points: {
        fontSize: fontSize['2xl'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        fontVariant: ['tabular-nums'],
    },
    pointsLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
})
