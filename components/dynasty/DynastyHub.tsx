import { newsFeedReady, updateNewsCache, type DynastyNewsCache, type NewsFeed } from '@/components/dynasty/news-cache'
import { DeferredContent } from '@/components/ui/DeferredContent'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { FlashList } from '@shopify/flash-list'
import { memo, useCallback, useEffect, useState } from 'react'
import {
    Linking,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/EmptyState'
import { ItemSeparator } from '@/components/ItemSeparator'
import { Card, ErrorBanner, Input, SegmentedControl } from '@/components/ui'
import { usePageMetrics } from '@/components/ui/Page'
import { RetainedPanel } from '@/components/ui/RetainedPanel'
import { useLeagueContext } from '@/contexts/league-context'
import { useDynastyRankings, type DynastyRankingView } from '@/hooks/use-dynasty-rankings'
import { useAuth } from '@/hooks/use-auth'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getDynastyNews, getMyDynastyNews, type DynastyNewsItem, type DynastyRankPlayer } from '@/lib/dynasty'
import { formatPoints, playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { API_URL } from '@/lib/shared/api'
import { getLeagueMembers } from '@/lib/league'
import { colors, fontSize, fontWeight, controlSize, layout, radii, spacing, table, textStyles } from '@/constants/tokens'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { readableSourceName } from '@/lib/source-names'

type DynastySection = 'rankings' | 'news'
const EMPTY_NEWS: DynastyNewsItem[] = []
const DYNASTY_NEWS_CACHE_PREFIX = 'pancake:dynasty-news:v1:'

const dynastyNewsCacheKey = (userId?: string, memberId?: string, leagueId?: string) =>
    `${DYNASTY_NEWS_CACHE_PREFIX}${userId ?? 'anon'}:${leagueId ?? 'none'}:${memberId ?? 'none'}`
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
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not synced'
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', '\u00a0')
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
            <MaterialIcons name={icon} size={controlSize.icon.sm} color={color} />
            {value !== 0 ? <Text style={[styles.rankMovementText, { color }]}>{Math.abs(value)}</Text> : null}
        </View>
    )
}

function RankingRowImpl({
    player,
    onPress,
}: {
    player: DynastyRankPlayer
    onPress: (player: DynastyRankPlayer) => void
}) {
    const positions = playerPositions(player)
    const canOpen = player.playerId != null
    const valueText = player.valueRange
        ? `${player.valueRange.low}–${player.valueRange.high}`
        : String(player.selectedValue ?? '—')
    const support = player.isDraftPick ? 'Future rookie pick' : [
        player.projectionPoints == null ? null : `${formatPoints(player.projectionPoints)} projected FP/G`,
        player.confidence == null ? null : `${Math.round(player.confidence * 100)}% confidence`,
    ].filter(Boolean).join(' · ')

    return (
        <Pressable
            onPress={() => onPress(player)}
            disabled={!canOpen}
            style={styles.rankRow}
            accessibilityRole={canOpen ? 'button' : undefined}
            accessibilityLabel={canOpen ? `Open ${player.displayName}` : player.displayName}
        >
            <View style={styles.rankNumber}>
                <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
                {player.rankChange !== 0 ? <RankMovement value={player.rankChange} /> : null}
            </View>
            {player.isDraftPick ? (
                <View style={styles.draftBadge}>
                    <MaterialIcons name="style" size={controlSize.icon.md} color={colors.primaryDark} />
                </View>
            ) : <Avatar name={player.displayName} uri={playerAvatarUri(player)} size={table.headerHeight} />}
            <View style={styles.rankMain}>
                <View style={styles.rankHeadline}>
                    <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                    <Text style={styles.valueText}>Value {valueText}</Text>
                </View>
                {!player.isDraftPick ? (
                    <View style={styles.metaRow}>
                        <Text style={styles.metaText} numberOfLines={1}>
                            {[player.sourceTeam ?? player.nbaTeam, positions.join('/')].filter(Boolean).join(' · ')}
                        </Text>
                        {player.injuryStatus ? <Text style={styles.injuryText}>{player.injuryStatus}</Text> : null}
                    </View>
                ) : null}
                {support ? <Text style={styles.decisionMeta} numberOfLines={1}>{support}</Text> : null}
            </View>
        </Pressable>
    )
}

const RankingRow = memo(RankingRowImpl)

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

/**
 * Dynasty rankings or news, shown as a section of the Players page. The
 * Players page owns the heading and the section tabs.
 */
export function DynastyHub({ section }: { section: DynastySection }) {
    const router = useRouter()
    const { padX } = usePageMetrics()
    const { user } = useAuth()
    const { current, currentLeague } = useLeagueContext()
    const [feed, setFeed] = useState<NewsFeed>('news')
    const { data: decisionMembers } = useFocusAsyncData(
        () => currentLeague ? getLeagueMembers(currentLeague.id) : Promise.resolve([]),
        [currentLeague?.id],
        { staleMs: 5 * 60_000, enabled: section === 'rankings' },
    )
    const rankings = useDynastyRankings({
        enabled: section === 'rankings',
        userId: user?.id ?? '',
        memberId: current?.id ?? '',
        leagueId: currentLeague?.id ?? '',
        scoringSettings: currentLeague?.scoring_settings,
        teamCount: Math.max(4, decisionMembers?.length ?? 12),
    })
    const handleOpenRankedPlayer = useCallback((player: DynastyRankPlayer) => {
        if (player.playerId) router.push(`/player/${player.playerId}`)
    }, [router])
    const renderRankingRow = useCallback(({ item }: { item: DynastyRankPlayer }) => (
        <RankingRow
            player={item}
            onPress={handleOpenRankedPlayer}
        />
    ), [handleOpenRankedPlayer])
    const cachedNews = readPersistentCache<DynastyNewsCache>(dynastyNewsCacheKey(user?.id, current?.id, currentLeague?.id)) ?? undefined
    const { data: newsData, loading: newsLoading, error: newsError, refresh: refreshNews } = useFocusAsyncData(
        async () => {
            const previous = readPersistentCache<DynastyNewsCache>(dynastyNewsCacheKey(user?.id, current?.id, currentLeague?.id))
            const items = feed === 'news'
                ? await getDynastyNews(30)
                : current && currentLeague ? await getMyDynastyNews(current.id, currentLeague.id, 30) : EMPTY_NEWS
            return updateNewsCache(previous, feed, items)
        },
        [current?.id, currentLeague?.id, user?.id, feed],
        { staleMs: 5 * 60_000, initialData: newsFeedReady(cachedNews, feed) ? cachedNews : undefined, enabled: section === 'news',
            onLoaded: (result) => writePersistentCache(dynastyNewsCacheKey(user?.id, current?.id, currentLeague?.id), result),
        },
    )
    const news = newsData?.news ?? EMPTY_NEWS
    const myNews = newsData?.myNews ?? EMPTY_NEWS
    const activeNews = feed === 'my-news' ? myNews : news
    const activeNewsHydrated = activeNews.length > 0 || (!newsLoading && !newsError && newsFeedReady(newsData, feed))
    const emptyNewsMessage = feed === 'my-news' ? 'No news for your players.' : 'No dynasty news yet.'
    const visibleSync = rankings.players.find((player) => Date.parse(player.rankFetchedAt) > 0)?.rankFetchedAt ?? null
    // A search that matches nothing has no rows to read the date from; keep the last one seen.
    const [knownSync, setKnownSync] = useState<string | null>(null)
    useEffect(() => {
        if (visibleSync && (!knownSync || Date.parse(visibleSync) > Date.parse(knownSync))) setKnownSync(visibleSync)
    }, [visibleSync, knownSync])
    const latestSync = visibleSync ?? knownSync
    const sourceNames = [...new Set(rankings.players.flatMap((player) =>
        player.decisionSources?.length
            ? player.decisionSources.map((source) => readableSourceName(source.name))
            : player.rankSource ? [readableSourceName(player.rankSource)] : [],
    ))]
    const rankingFooter = (
        <View>
            {rankings.loadMoreError ? (
                <Pressable style={styles.footerRetry} onPress={() => void rankings.retryLoadMore()} accessibilityRole="button" accessibilityLabel="Retry rankings">
                    <MaterialIcons name="refresh" size={controlSize.icon.sm} color={colors.primaryDark} />
                    <Text style={styles.footerRetryText}>Retry rankings</Text>
                </Pressable>
            ) : null}
            {rankings.players.length > 0 ? (
                <Text style={styles.sourceFootnote}>
                    {[sourceNames.length ? `Sources: ${sourceNames.join(', ')}` : null, latestSync ? `Updated ${formatDate(latestSync)}` : null].filter(Boolean).join(' · ')}
                </Text>
            ) : null}
        </View>
    )

    return (
            <View style={[styles.contentWrap, { paddingHorizontal: padX }]}>
                <View style={styles.body}>
                <RetainedPanel active={section === 'rankings'}>
                    <View style={styles.body}>
                        <View style={styles.controlRow}>
                            <SegmentedControl<DynastyRankingView>
                                value={rankings.view}
                                onChange={rankings.setView}
                                options={[
                                    { label: '5-Year Points', value: 'five-year' },
                                    { label: '3-Year Points', value: 'three-year' },
                                    { label: 'Rookies & Picks', value: 'rookies-picks' },
                                ]}
                                accessibilityLabel="Dynasty ranking views"
                                idBase="dynasty-ranking-view"
                                scrollable
                            />
                        </View>
                        <View style={styles.searchRow}>
                            <Input
                                value={rankings.query}
                                onChangeText={rankings.setQuery}
                                placeholder="Search rankings"
                                leftIcon="search"
                                autoCorrect={false}
                                accessibilityLabel="Search dynasty rankings"
                                containerStyle={styles.searchField}
                            />
                        </View>
                        {rankings.error && rankings.players.length > 0 ? <ErrorBanner message="Rankings could not refresh. Tap to retry." onRetry={() => void rankings.refresh()} /> : null}
                        <DeferredContent ready={!rankings.loading || rankings.players.length > 0 || Boolean(rankings.error)}>
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
                                key={rankings.view}
                                data={rankings.players}
                                keyExtractor={(player) => player.rankingId}
                                ItemSeparatorComponent={ItemSeparator}
                                contentContainerStyle={rankings.players.length === 0 && !rankings.loading ? styles.emptyContainer : undefined}
                                renderItem={renderRankingRow}
                                ListEmptyComponent={rankings.loading
                                    ? null
                                    : rankings.query.trim()
                                        ? <EmptyState message={`No ranked players match "${rankings.query.trim()}".`} actionLabel="Clear search" onAction={() => rankings.setQuery('')} fullScreen={false} />
                                    : latestSync
                                        ? <EmptyState message="No ranked players in this view." fullScreen={false} />
                                        : <EmptyState message="Rankings haven't synced yet." description="They refresh daily from the published dynasty ranks. Check back after the next sync." fullScreen={false} />}
                                ListFooterComponent={rankingFooter}
                                onEndReached={rankings.loadMore}
                                onEndReachedThreshold={0.4}
                            />
                        )}
                        </DeferredContent>
                    </View>
                </RetainedPanel>
                <RetainedPanel active={section === 'news'}>
                    <ScrollView
                        contentContainerStyle={styles.newsContent}
                    >
                        <View style={styles.controlRow}>
                            <SegmentedControl<NewsFeed>
                                value={feed}
                                onChange={setFeed}
                                options={[
                                    { label: 'All news', value: 'news' },
                                    { label: 'My players', value: 'my-news', badge: myNews.length },
                                ]}
                                accessibilityLabel="News feed"
                                idBase="dynasty-news-feed"
                                scrollable
                            />
                        </View>
                        {newsError ? (
                            <ErrorBanner message="Failed to load news. Tap to retry." onRetry={() => void refreshNews()} />
                        ) : null}
                        {/* Blank until hydrated — the card appears fully formed
                            instead of swapping a loading line for news rows. */}
                        <DeferredContent ready={activeNewsHydrated}>
                        {activeNewsHydrated ? (
                            <Card padding="md" radius="md" elevated="none" style={styles.listCard}>
                                {activeNews.length === 0 ? (
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
                        ) : null}
                        </DeferredContent>
                    </ScrollView>
                </RetainedPanel>
                </View>
            </View>
    )
}

const styles = StyleSheet.create({
    contentWrap: {
        flex: 1,
        width: '100%',
        maxWidth: layout.contentMaxWidth,
        alignSelf: 'center',
        paddingTop: spacing.md,
    },
    body: { flex: 1, gap: spacing.md },
    // Ranking views or news feeds use the full
    // width so the scrollable track has a definite size when it overflows.
    controlRow: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    searchField: { flex: 1, maxWidth: 420 },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    rankRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: spacing.md,
        gap: spacing.md,
    },
    rankNumber: {
        width: table.headerHeight,
        alignItems: 'center',
        gap: spacing.xxs,
    },
    rankNumberText: { ...textStyles.rowTitle, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    rankMovement: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xxs,
    },
    rankMovementText: { ...textStyles.meta, fontSize: fontSize.xs },
    rankMain: { flex: 1, minWidth: 0, gap: spacing.xxs },
    rankHeadline: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
    playerName: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    valueText: { ...textStyles.stat, fontWeight: fontWeight.bold, color: colors.primaryDark },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    metaText: { ...textStyles.meta, flexShrink: 1 },
    injuryText: { ...textStyles.meta, color: colors.danger },
    draftBadge: {
        width: table.headerHeight,
        height: table.headerHeight,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primaryLight,
    },
    decisionMeta: { ...textStyles.meta },
    sourceFootnote: { ...textStyles.meta, paddingVertical: spacing.lg },
    newsContent: { paddingBottom: spacing.xl, gap: spacing.md, width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center' },
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
