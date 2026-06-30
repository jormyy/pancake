import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { FlashList } from '@shopify/flash-list'
import { useState } from 'react'
import {
    ActivityIndicator,
    Linking,
    Pressable,
    RefreshControl,
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
import { Card, Input, SegmentedControl } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { useDynastyRankings } from '@/hooks/use-dynasty-rankings'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getDynastyNews, getMyDynastyNews, type DynastyNewsItem, type DynastyRankPlayer } from '@/lib/dynasty'
import { playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { API_URL } from '@/lib/shared/api'
import { colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'

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
const STAT_COLUMNS: { key: StatKey; label: string; format?: 'integer' | 'pct' }[] = [
    { key: 'gamesPlayed', label: 'GP', format: 'integer' },
    { key: 'fieldGoalPct', label: 'FG%', format: 'pct' },
    { key: 'freeThrowPct', label: 'FT%', format: 'pct' },
    { key: 'threePointersMade', label: '3PM' },
    { key: 'points', label: 'PTS' },
    { key: 'rebounds', label: 'REB' },
    { key: 'assists', label: 'AST' },
    { key: 'steals', label: 'STL' },
    { key: 'blocks', label: 'BLK' },
    { key: 'turnovers', label: 'TO' },
]

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
    return Number(value).toFixed(1)
}

function sourceMeta(player: DynastyRankPlayer): string[] {
    const parts: string[] = []
    const team = player.sourceTeam ?? player.nbaTeam
    if (team) parts.push(team)
    if (player.age != null) parts.push(`${player.age.toFixed(1)} yo`)
    return parts
}

function playerPositions(player: DynastyRankPlayer): string[] {
    if (player.sourcePositions.length > 0) return player.sourcePositions
    return getEligiblePositions({ eligible_positions: player.eligiblePositions, position: player.position })
}

function RankMovement({ value }: { value: number }) {
    const icon = value > 0 ? 'trending-up' : value < 0 ? 'trending-down' : 'trending-flat'
    const color = value > 0 ? colors.successDark : value < 0 ? colors.danger : colors.textMuted

    return (
        <View style={styles.rankMovement}>
            <MaterialIcons name={icon} size={14} color={color} />
            {value !== 0 ? <Text style={[styles.rankMovementText, { color }]}>{Math.abs(value)}</Text> : null}
        </View>
    )
}

function StatStrip({ player, compact }: { player: DynastyRankPlayer; compact: boolean }) {
    return (
        <View style={[styles.statStrip, compact && styles.statStripCompact]}>
            {STAT_COLUMNS.map((stat) => (
                <View key={stat.key} style={styles.statCell}>
                    <Text style={styles.statValue}>{formatStat(player[stat.key], stat.format)}</Text>
                    <Text style={styles.statLabel}>{stat.label}</Text>
                </View>
            ))}
        </View>
    )
}

function RankingRow({
    player,
    compact,
    onPress,
}: {
    player: DynastyRankPlayer
    compact: boolean
    onPress: () => void
}) {
    const positions = playerPositions(player)
    const canOpen = player.playerId != null
    const headshotUri = playerAvatarUri(player)

    return (
        <Pressable
            onPress={onPress}
            disabled={!canOpen}
            style={[styles.rankRow, compact && styles.rankRowCompact]}
            accessibilityRole={canOpen ? 'button' : undefined}
            accessibilityLabel={canOpen ? `Open ${player.displayName}` : player.displayName}
        >
            <View style={styles.rankNumber}>
                <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
                <RankMovement value={player.rankChange} />
            </View>

            <Avatar name={player.displayName} uri={headshotUri} size={compact ? 44 : 52} />

            <View style={styles.rankMain}>
                <View style={styles.rankTitleRow}>
                    <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                    {canOpen ? <MaterialIcons name="chevron-right" size={22} color={colors.textPlaceholder} /> : null}
                </View>
                <View style={styles.metaRow}>
                    {sourceMeta(player).map((part) => <Text key={part} style={styles.metaText}>{part}</Text>)}
                    {positions.map((pos) => <Text key={pos} style={styles.positionPill}>{pos}</Text>)}
                    {player.injuryStatus ? <Text style={styles.metaText}>{player.injuryStatus}</Text> : null}
                </View>
                {compact ? <StatStrip player={player} compact /> : null}
                {player.comment ? <Text style={styles.comment} numberOfLines={compact ? 2 : 3}>{player.comment}</Text> : null}
            </View>

            {!compact ? <StatStrip player={player} compact={false} /> : null}
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
                <Text style={styles.newsPlayer}>{item.playerName}{item.playerTeam ? ` - ${item.playerTeam}` : ''}</Text>
            ) : null}
        </Pressable>
    )
}

export default function DynastyScreen() {
    const router = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { width } = useWindowDimensions()
    const compactRows = width < 980
    const [tab, setTab] = useState<DynastyTab>('rankings')
    const rankings = useDynastyRankings()
    const {
        data: newsData,
        loading: newsLoading,
        refreshing: newsRefreshing,
        refresh: refreshNews,
    } = useFocusAsyncData(
        async () => {
            const [news, myNews] = await Promise.all([
                getDynastyNews(30),
                current && currentLeague ? getMyDynastyNews(current.id, currentLeague.id, 30) : Promise.resolve(EMPTY_NEWS),
            ])
            return { news, myNews }
        },
        [current?.id, currentLeague?.id],
        { staleMs: 5 * 60_000 },
    )
    const news = newsData?.news ?? EMPTY_NEWS
    const myNews = newsData?.myNews ?? EMPTY_NEWS
    const activeNews = tab === 'my-news' ? myNews : news
    const emptyNewsMessage = tab === 'my-news' ? 'No news for your players.' : 'No dynasty news yet.'
    const latestSync = rankings.players.find((player) => player.rankFetchedAt)?.rankFetchedAt ?? null
    const rankingFooter = rankings.loadingMore ? (
        <ActivityIndicator style={styles.loadMoreSpinner} color={colors.primary} />
    ) : rankings.loadMoreError ? (
        <Pressable style={styles.footerRetry} onPress={() => void rankings.retryLoadMore()} accessibilityRole="button" accessibilityLabel="Retry loading rankings">
            <MaterialIcons name="refresh" size={16} color={colors.primaryDark} />
            <Text style={styles.footerRetryText}>Retry loading rankings</Text>
        </Pressable>
    ) : null

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.contentWrap}>
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        <Text style={styles.title}>Dynasty Hub</Text>
                        <Text style={styles.subtitle}>Hashtag rankings and player movement</Text>
                    </View>
                    {rankings.loading && rankings.players.length === 0 ? <ActivityIndicator color={colors.primary} /> : (
                        <View style={styles.syncPill}>
                            <MaterialIcons name="sync" size={14} color={colors.primaryDark} />
                            <Text style={styles.syncText}>{formatDate(latestSync)}</Text>
                        </View>
                    )}
                </View>

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

                {tab === 'rankings' ? (
                    <>
                        <View style={styles.searchRow}>
                            <Input
                                value={rankings.query}
                                onChangeText={rankings.setQuery}
                                placeholder="Search dynasty rankings"
                                leftIcon="search"
                                autoCorrect={false}
                            />
                            <Text style={styles.resultCountText}>
                                {rankings.loading && rankings.players.length === 0
                                    ? 'Loading...'
                                    : rankings.refreshing
                                      ? `Updating ${rankings.players.length} rows`
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
                        ) : rankings.loading && rankings.players.length === 0 ? (
                            <ActivityIndicator style={styles.flex1} color={colors.primary} />
                        ) : (
                            <FlashList
                                data={rankings.players}
                                keyExtractor={(player) => player.rankingId}
                                ItemSeparatorComponent={ItemSeparator}
                                contentContainerStyle={rankings.players.length === 0 ? styles.emptyContainer : undefined}
                                renderItem={({ item }) => (
                                    <RankingRow
                                        player={item}
                                        compact={compactRows}
                                        onPress={() => item.playerId && router.push(`/player/${item.playerId}`)}
                                    />
                                )}
                                ListEmptyComponent={<EmptyState message="No ranked players found." fullScreen={false} />}
                                ListFooterComponent={rankingFooter}
                                onEndReached={rankings.loadMore}
                                onEndReachedThreshold={0.4}
                                refreshControl={<RefreshControl refreshing={rankings.refreshing} onRefresh={rankings.refresh} tintColor={colors.primary} />}
                            />
                        )}
                    </>
                ) : (
                    <ScrollView
                        contentContainerStyle={styles.newsContent}
                        refreshControl={<RefreshControl refreshing={newsRefreshing} onRefresh={refreshNews} tintColor={colors.primary} />}
                    >
                        <Card padding="md" radius="md" elevated="none" style={styles.listCard}>
                            {newsLoading && activeNews.length === 0 ? (
                                <ActivityIndicator color={colors.primary} style={styles.loadingBlock} />
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
        paddingHorizontal: spacing.xl,
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
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    resultCountText: {
        flexShrink: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    rankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        minHeight: 104,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md,
    },
    rankRowCompact: {
        alignItems: 'flex-start',
        minHeight: 132,
        gap: spacing.md,
    },
    rankNumber: {
        width: 52,
        alignItems: 'center',
        gap: spacing.xs,
    },
    rankNumberText: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    rankMovement: {
        minHeight: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    rankMovementText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    rankMain: { flex: 1, minWidth: 0, gap: spacing.xs },
    rankTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    playerName: { flex: 1, minWidth: 0, fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
    metaText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    positionPill: {
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        borderRadius: radii.sm,
        backgroundColor: colors.bgMuted,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    comment: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textSecondary,
    },
    statStrip: {
        width: 500,
        flexDirection: 'row',
        alignItems: 'stretch',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        overflow: 'hidden',
        backgroundColor: colors.bgCard,
    },
    statStripCompact: {
        width: '100%',
        maxWidth: 520,
        flexWrap: 'wrap',
        borderWidth: 0,
        gap: spacing.xs,
        backgroundColor: 'transparent',
    },
    statCell: {
        width: 50,
        minHeight: 42,
        alignItems: 'center',
        justifyContent: 'center',
        borderRightWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    statValue: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    statLabel: { marginTop: 1, fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted },
    newsContent: { paddingBottom: spacing.xl },
    listCard: { overflow: 'hidden' },
    newsRow: { paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: spacing.sm },
    newsTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
    newsSource: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textTransform: 'uppercase' },
    newsDate: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    newsTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    newsSummary: { fontSize: fontSize.md, lineHeight: 20, color: colors.textSecondary },
    newsPlayer: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    separator: { height: 1, backgroundColor: colors.borderLight },
    loadingBlock: { paddingVertical: spacing['5xl'] },
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
