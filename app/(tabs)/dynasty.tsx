import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { FlashList } from '@shopify/flash-list'
import { useState } from 'react'
import {
    Linking,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/EmptyState'
import { ItemSeparator } from '@/components/ItemSeparator'
import { PosTag } from '@/components/PosTag'
import { Card, Input, SegmentedControl } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useDynastyRankings } from '@/hooks/use-dynasty-rankings'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getDynastyNews, getMyDynastyNews, type DynastyNewsItem, type DynastyRankPlayer } from '@/lib/dynasty'
import { formatPoints, playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { API_URL } from '@/lib/shared/api'
import { colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

type DynastyTab = 'rankings' | 'news' | 'my-news'
type StatKey = keyof Pick<
    DynastyRankPlayer,
    | 'gamesPlayed'
    | 'fieldGoalPct'
    | 'freeThrowPct'
    | 'threePointersMade'
    | 'points'
    | 'rebounds'
    | 'assists'
    | 'steals'
    | 'blocks'
    | 'turnovers'
>

const EMPTY_NEWS: DynastyNewsItem[] = []
type DynastyNewsCache = { news: DynastyNewsItem[]; myNews: DynastyNewsItem[] }
type StatColumn = { key: StatKey; label: string; format?: 'integer' | 'pct' }
const DYNASTY_NEWS_CACHE_PREFIX = 'pancake:dynasty-news:v1:'

const dynastyNewsCacheKey = (memberId?: string, leagueId?: string) =>
    `${DYNASTY_NEWS_CACHE_PREFIX}${leagueId ?? 'none'}:${memberId ?? 'anon'}`
// Full table shown on wide screens; column labels live in the table header row.
const STAT_COLUMNS: StatColumn[] = [
    { key: 'points', label: 'PTS' },
    { key: 'rebounds', label: 'REB' },
    { key: 'assists', label: 'AST' },
    { key: 'steals', label: 'STL' },
    { key: 'blocks', label: 'BLK' },
    { key: 'threePointersMade', label: '3PM' },
    { key: 'turnovers', label: 'TO' },
    { key: 'gamesPlayed', label: 'GP', format: 'integer' },
    { key: 'fieldGoalPct', label: 'FG%', format: 'pct' },
    { key: 'freeThrowPct', label: 'FT%', format: 'pct' },
]
// On narrow screens each player stays a single tidy row, so only the headline
// counting stats ride inline under the name.
const COMPACT_STAT_COLUMNS: StatColumn[] = STAT_COLUMNS.filter((column) =>
    ['points', 'rebounds', 'assists', 'steals', 'blocks'].includes(column.key),
)
const STAT_CELL_WIDTH = 54
const RANK_COL_WIDTH = 44
const HEADSHOT_SIZE = 44
// Below this the stat table is dropped for the inline compact strip.
const WIDE_BREAKPOINT = 1200
const STAT_GRID_WIDTH = STAT_COLUMNS.length * STAT_CELL_WIDTH

function isPlaceholderHeadshot(uri: string | null): boolean {
    return uri?.endsWith('/0.png') ?? false
}

function proxiedNbaHeadshotUrl(nbaId: string | null): string | null {
    if (!nbaId) return null
    return `${API_URL}/players/headshot/${nbaId}`
}

function playerAvatarUri(player: DynastyRankPlayer): string | null {
    if (player.headshotUrl && !isPlaceholderHeadshot(player.headshotUrl)) return player.headshotUrl
    return proxiedNbaHeadshotUrl(player.nbaId) ?? playerHeadshotUrl(player.nbaId) ?? player.headshotUrl
}

function formatDate(value: string | null): string {
    if (!value) return 'Not synced'
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatStat(value: number | null, format?: 'integer' | 'pct'): string {
    if (value == null) return '-'
    if (format === 'integer') return String(Math.round(value))
    if (format === 'pct') return Number(value).toFixed(3)
    return formatPoints(value)
}

function formatScoringFormat(value: string | null | undefined): string {
    if (value === 'points') return 'points-league'
    if (value === 'category') return 'category'
    if (value === 'custom') return 'custom'
    return 'overall'
}

function sourceMeta(player: DynastyRankPlayer): string[] {
    const parts: string[] = []
    const team = player.sourceTeam ?? player.nbaTeam
    if (team) parts.push(team)
    if (player.age != null) parts.push(`${player.age.toFixed(1)} yo`)
    return parts
}

function playerPositions(player: DynastyRankPlayer): string[] {
    if (player.sourcePositions?.length) return player.sourcePositions
    return getEligiblePositions({ eligible_positions: player.eligiblePositions, position: player.position })
}

function RankMovement({ value }: { value: number }) {
    const icon = value > 0 ? 'trending-up' : value < 0 ? 'trending-down' : 'trending-flat'
    const color = value > 0 ? colors.successDark : value < 0 ? colors.danger : colors.textMuted

    return (
        <View style={styles.rankMovement}>
            <MaterialIcons name={icon} size={13} color={color} />
            {value !== 0 ? <Text style={[styles.rankMovementText, { color }]}>{Math.abs(value)}</Text> : null}
        </View>
    )
}

function StatGrid({ player }: { player: DynastyRankPlayer }) {
    return (
        <View style={styles.statsGrid}>
            {STAT_COLUMNS.map((stat) => (
                <Text key={stat.key} style={styles.statCell} numberOfLines={1}>
                    {formatStat(player[stat.key], stat.format)}
                </Text>
            ))}
        </View>
    )
}

function CompactStats({ player }: { player: DynastyRankPlayer }) {
    return (
        <View style={styles.compactStats}>
            {COMPACT_STAT_COLUMNS.map((stat) => (
                <View key={stat.key} style={styles.compactStat}>
                    <Text style={styles.compactStatLabel}>{stat.label}</Text>
                    <Text style={styles.compactStatValue}>{formatStat(player[stat.key], stat.format)}</Text>
                </View>
            ))}
        </View>
    )
}

function RankingsTableHeader() {
    return (
        <View style={styles.tableHeader}>
            <View style={styles.rankColSpacer} />
            <View style={styles.headshotSpacer} />
            <Text style={styles.tableHeaderPlayer}>Player</Text>
            <View style={styles.statsGrid}>
                {STAT_COLUMNS.map((stat) => (
                    <Text key={stat.key} style={styles.statHeaderCell} numberOfLines={1}>{stat.label}</Text>
                ))}
            </View>
        </View>
    )
}

function RankingRow({
    player,
    showStats,
    onPress,
}: {
    player: DynastyRankPlayer
    showStats: boolean
    onPress: () => void
}) {
    const positions = playerPositions(player)
    const canOpen = player.playerId != null
    // hashtagbasketball stacks the write-up directly beneath that player's stats
    // (same column); we mirror that — stats on top, comment on the line below.
    const commentNode = player.comment ? <Text style={styles.comment}>{player.comment}</Text> : null

    // Draft-pick placeholders carry no player, stats, or headshot — they're
    // ranked slots (e.g. an incoming 2026 first-rounder), so render a slim row.
    if (player.isDraftPick) {
        return (
            <View style={styles.rankRow}>
                <View style={styles.rankRowTop}>
                    <View style={styles.rankNumber}>
                        <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
                        <RankMovement value={player.rankChange} />
                    </View>
                    <View style={styles.draftBadge}>
                        <MaterialIcons name="style" size={20} color={colors.primaryDark} />
                    </View>
                    <View style={styles.rankMain}>
                        <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                        <Text style={styles.draftLabel}>Future draft pick</Text>
                    </View>
                </View>
            </View>
        )
    }

    return (
        <Pressable
            onPress={onPress}
            disabled={!canOpen}
            style={styles.rankRow}
            accessibilityRole={canOpen ? 'button' : undefined}
            accessibilityLabel={canOpen ? `Open ${player.displayName}` : player.displayName}
        >
            <View style={styles.rankRowTop}>
                <View style={styles.rankNumber}>
                    <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
                    <RankMovement value={player.rankChange} />
                </View>

                <Avatar name={player.displayName} uri={playerAvatarUri(player)} size={HEADSHOT_SIZE} />

                <View style={styles.rankMain}>
                    <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                    <View style={styles.metaRow}>
                        {sourceMeta(player).map((part) => <Text key={part} style={styles.metaText}>{part}</Text>)}
                        {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                        {player.injuryStatus ? <Text style={styles.injuryText}>{player.injuryStatus}</Text> : null}
                    </View>
                    {!showStats ? <CompactStats player={player} /> : null}
                    {!showStats ? commentNode : null}
                </View>

                {showStats ? (
                    <View style={styles.statsBlock}>
                        <StatGrid player={player} />
                        {commentNode}
                    </View>
                ) : null}
            </View>
        </Pressable>
    )
}

function NewsRow({ item }: { item: DynastyNewsItem }) {
    const open = () => {
        if (item.url) void Linking.openURL(item.url)
    }

    return (
        <Pressable
            onPress={open}
            disabled={!item.url}
            style={styles.newsRow}
            accessibilityRole={item.url ? 'link' : undefined}
            accessibilityLabel={item.title}
        >
            <View style={styles.newsTopLine}>
                <Text style={styles.newsSource}>{item.source}</Text>
                <Text style={styles.newsDate}>{formatDate(item.publishedAt)}</Text>
            </View>
            <Text style={styles.newsTitle}>{item.title}</Text>
            <Text style={styles.newsSummary}>{item.summary}</Text>
            {item.playerName ? (
                <View style={styles.newsPlayerRow}>
                    <Avatar
                        name={item.playerName}
                        uri={playerHeadshotUrl(item.playerNbaId)}
                        color={colors.bgMuted}
                        textColor={colors.textSecondary}
                        size={28}
                    />
                    <Text style={styles.newsPlayer} numberOfLines={1}>
                        {item.playerName}{item.playerTeam ? ` - ${item.playerTeam}` : ''}
                    </Text>
                </View>
            ) : null}
        </Pressable>
    )
}

export default function DynastyScreen() {
    const router = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { width } = useWindowDimensions()
    const showStats = width >= WIDE_BREAKPOINT
    const narrowSearch = width < 440
    const [tab, setTab] = useState<DynastyTab>('rankings')
    const rankings = useDynastyRankings()
    const cachedNews = readPersistentCache<DynastyNewsCache>(dynastyNewsCacheKey(current?.id, currentLeague?.id)) ?? undefined
    const { data: newsData, loading: newsLoading } = useFocusAsyncData(
        async () => {
            const [news, myNews] = await Promise.all([
                getDynastyNews(30),
                current && currentLeague ? getMyDynastyNews(current.id, currentLeague.id, 30) : Promise.resolve(EMPTY_NEWS),
            ])
            const result = { news, myNews }
            writePersistentCache(dynastyNewsCacheKey(current?.id, currentLeague?.id), result)
            return result
        },
        [current?.id, currentLeague?.id],
        { staleMs: 5 * 60_000, initialData: cachedNews },
    )
    const news = newsData?.news ?? EMPTY_NEWS
    const myNews = newsData?.myNews ?? EMPTY_NEWS
    const activeNews = tab === 'my-news' ? myNews : news
    const activeNewsHydrated = !newsLoading || activeNews.length > 0
    const emptyNewsMessage = tab === 'my-news' ? 'No news for your players.' : 'No dynasty news yet.'
    const latestSync = rankings.players.find((player) => player.rankFetchedAt)?.rankFetchedAt ?? null
    const scoringFormat = rankings.players.find((player) => player.scoringFormat)?.scoringFormat ?? null
    const rankingFooter = rankings.loadingMore ? null : rankings.loadMoreError ? (
        <Pressable style={styles.footerRetry} onPress={() => void rankings.retryLoadMore()} accessibilityRole="button" accessibilityLabel="Retry rankings">
            <MaterialIcons name="refresh" size={16} color={colors.primaryDark} />
            <Text style={styles.footerRetryText}>Retry rankings</Text>
        </Pressable>
    ) : null

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.contentWrap}>
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        <Text style={styles.title} role="heading" aria-level={1}>Dynasty Hub</Text>
                        <Text style={styles.subtitle}>
                            Hashtag {formatScoringFormat(scoringFormat)} rankings and player movement
                        </Text>
                    </View>
                    <View style={styles.syncPill}>
                        <MaterialIcons name="sync" size={14} color={colors.primaryDark} />
                        <Text style={styles.syncText}>{formatDate(latestSync)}</Text>
                    </View>
                </View>

                <View style={styles.tabBar}>
                    <SegmentedControl<DynastyTab>
                        value={tab}
                        onChange={setTab}
                        options={[
                            { label: 'Rankings', value: 'rankings', badge: rankings.players.length },
                            { label: 'News', value: 'news', badge: news.length },
                            { label: 'My News', value: 'my-news', badge: myNews.length },
                        ]}
                        scrollable
                    />
                </View>

                <View style={styles.body}>
                {tab === 'rankings' ? (
                    <>
                        <View style={styles.searchRow}>
                            <Input
                                value={rankings.query}
                                onChangeText={rankings.setQuery}
                                placeholder={narrowSearch ? 'Search rankings' : 'Search dynasty rankings'}
                                leftIcon="search"
                                autoCorrect={false}
                            />
                            <Text style={styles.resultCountText}>
                                {rankings.loading && rankings.players.length === 0
                                    ? '— rows'
                                    : `${rankings.players.length} row${rankings.players.length === 1 ? '' : 's'} loaded`}
                            </Text>
                        </View>
                        {rankings.error && rankings.players.length === 0 ? (
                            <View style={styles.errorState}>
                                <MaterialIcons name="error-outline" size={26} color={colors.danger} />
                                <Text style={styles.errorTitle}>Rankings could not load</Text>
                                <Text style={styles.errorText}>{rankings.error.message}</Text>
                                <Pressable style={styles.retryButton} onPress={() => void rankings.refresh()} accessibilityRole="button" accessibilityLabel="Retry rankings">
                                    <MaterialIcons name="refresh" size={18} color={colors.textWhite} />
                                    <Text style={styles.retryButtonText}>Retry</Text>
                                </Pressable>
                            </View>
                        ) : (
                            <FlashList
                                data={rankings.players}
                                extraData={showStats}
                                keyExtractor={(player) => player.rankingId}
                                ItemSeparatorComponent={ItemSeparator}
                                contentContainerStyle={rankings.players.length === 0 && !rankings.loading ? styles.emptyContainer : undefined}
                                ListHeaderComponent={showStats ? <RankingsTableHeader /> : null}
                                renderItem={({ item }) => (
                                    <RankingRow
                                        player={item}
                                        showStats={showStats}
                                        onPress={() => item.playerId && router.push(`/player/${item.playerId}`)}
                                    />
                                )}
                                ListEmptyComponent={rankings.loading
                                    ? <EmptyState message="Loading dynasty rankings…" fullScreen={false} />
                                    : <EmptyState message="No ranked players found." fullScreen={false} />}
                                ListFooterComponent={rankingFooter}
                                onEndReached={rankings.loadMore}
                                onEndReachedThreshold={0.4}
                            />
                        )}
                    </>
                ) : (
                    <ScrollView
                        contentContainerStyle={styles.newsContent}
                    >
                        <Card padding="md" radius="md" elevated="none" style={styles.listCard}>
                            {!activeNewsHydrated ? (
                                <EmptyState message="Loading dynasty news…" fullScreen={false} />
                            ) : activeNews.length === 0 ? (
                                <EmptyState message={emptyNewsMessage} fullScreen={false} />
                            ) : (
                                activeNews.map((item, index) => (
                                    <View key={item.id}>
                                        <NewsRow item={item} />
                                        {index < activeNews.length - 1 ? <View style={styles.separator} /> : null}
                                    </View>
                                ))
                            )}
                        </Card>
                    </ScrollView>
                )}
                </View>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: {
        flex: 1,
        width: '100%',
        maxWidth: layout.contentMaxWidth,
        alignSelf: 'center',
        paddingHorizontal: spacing['3xl'],
        paddingTop: spacing.xl,
        gap: spacing.lg,
    },
    flex1: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.lg,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: {
        fontSize: fontSize['3xl'],
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    subtitle: {
        marginTop: spacing.xs,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    syncPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        minHeight: 34,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.full,
        backgroundColor: colors.primaryLight,
    },
    syncText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    // Fixed-height tab strip: wrapping the (scrollable → RNW ScrollView)
    // control stops it from flex-growing and floating the tabs mid-screen,
    // which also keeps them pinned in place when switching tabs. Full width so
    // the horizontal track has a definite size to scroll within when it overflows.
    tabBar: { width: '100%' },
    // gap separates the search row from the list below it (rankings tab); the
    // news tab has a single child so the gap is inert there.
    body: { flex: 1, gap: spacing.lg },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    // Shrinks and wraps ("50 rows / loaded") on narrow phones instead of
    // pushing past the viewport edge and clipping the search field.
    resultCountText: {
        flexShrink: 1,
        minWidth: 96,
        textAlign: 'right',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    tableHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
    },
    rankColSpacer: { width: RANK_COL_WIDTH },
    headshotSpacer: { width: HEADSHOT_SIZE },
    tableHeaderPlayer: {
        flex: 1,
        minWidth: 0,
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
    },
    rankRow: {
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.lg,
    },
    // Top-aligned so the stats sit level with the player name and the blurb can
    // grow downward beneath them without re-centering the identity column.
    rankRowTop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.lg,
    },
    rankNumber: {
        width: RANK_COL_WIDTH,
        alignItems: 'center',
        gap: spacing.xxs,
    },
    rankNumberText: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    rankMovement: {
        minHeight: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    rankMovementText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    rankMain: { flex: 1, minWidth: 0, gap: spacing.xxs },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
    metaText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    injuryText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.danger },
    draftBadge: {
        width: HEADSHOT_SIZE,
        height: HEADSHOT_SIZE,
        borderRadius: HEADSHOT_SIZE / 2,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primaryLight,
    },
    draftLabel: {
        marginTop: spacing.xxs,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    // Sits directly under the stats (wide) or the inline strip (compact); no
    // line clamp so it wraps to as many lines as it needs.
    comment: {
        marginTop: spacing.sm,
        fontSize: fontSize.sm,
        lineHeight: 19,
        color: colors.textMuted,
    },
    // Right column on wide screens: stat row on top, blurb stacked beneath it.
    statsBlock: {
        width: STAT_GRID_WIDTH,
        flexShrink: 0,
    },
    statsGrid: {
        width: STAT_GRID_WIDTH,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        flexShrink: 0,
    },
    statCell: {
        width: STAT_CELL_WIDTH,
        textAlign: 'right',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
        fontVariant: ['tabular-nums'],
    },
    statHeaderCell: {
        width: STAT_CELL_WIDTH,
        textAlign: 'right',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
    },
    compactStats: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: spacing.lg,
        rowGap: spacing.xs,
        marginTop: spacing.xs,
    },
    compactStat: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
    compactStatLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 0.4 },
    compactStatValue: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    newsContent: { paddingBottom: spacing.xl },
    listCard: { overflow: 'hidden' },
    newsRow: { paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: spacing.sm },
    newsTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
    newsSource: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textTransform: 'uppercase' },
    newsDate: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    newsTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    newsSummary: { fontSize: fontSize.md, lineHeight: 20, color: colors.textSecondary },
    newsPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    newsPlayer: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    separator: { height: 1, backgroundColor: colors.borderLight },
    loadMoreSpinner: { paddingVertical: spacing.xl },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    errorState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md,
        padding: spacing['4xl'],
    },
    errorTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    errorText: {
        maxWidth: 520,
        textAlign: 'center',
        fontSize: fontSize.sm,
        lineHeight: 20,
        color: colors.textMuted,
    },
    retryButton: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        borderRadius: radii.md,
        paddingHorizontal: spacing.xl,
        backgroundColor: colors.primary,
    },
    retryButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textWhite },
    footerRetry: {
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
    },
    footerRetryText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
