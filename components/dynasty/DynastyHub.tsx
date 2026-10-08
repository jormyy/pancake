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
    useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/EmptyState'
import { ItemSeparator } from '@/components/ItemSeparator'
import { PosTag } from '@/components/PosTag'
import { Card, ErrorBanner, Input, SegmentedControl } from '@/components/ui'
import { usePageMetrics } from '@/components/ui/Page'
import { useLeagueContext } from '@/contexts/league-context'
import { useDynastyRankings, type DynastyRankingView } from '@/hooks/use-dynasty-rankings'
import { useAuth } from '@/hooks/use-auth'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getDynastyNews, getMyDynastyNews, type DynastyNewsItem, type DynastyRankPlayer } from '@/lib/dynasty'
import { formatPoints, playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import { API_URL } from '@/lib/shared/api'
import { getLeagueMembers } from '@/lib/league'
import { colors, fontSize, fontWeight, layout, radii, spacing, table, textStyles } from '@/constants/tokens'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { readableSourceName } from '@/lib/source-names'

type NewsFeed = 'news' | 'my-news'
export type DynastySection = 'rankings' | 'news'
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

const dynastyNewsCacheKey = (userId?: string, memberId?: string, leagueId?: string) =>
    `${DYNASTY_NEWS_CACHE_PREFIX}${userId ?? 'anon'}:${leagueId ?? 'none'}:${memberId ?? 'none'}`
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
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not synced'
    return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', '\u00a0')
}

function formatStat(value: number | null, format?: 'integer' | 'pct'): string {
    if (value == null) return '—'
    if (format === 'integer') return String(Math.round(value))
    if (format === 'pct') return Number(value).toFixed(3)
    return formatPoints(value)
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

function RankingRowImpl({
    player,
    showStats,
    narrow,
    onPress,
}: {
    player: DynastyRankPlayer
    showStats: boolean
    narrow: boolean
    onPress: (player: DynastyRankPlayer) => void
}) {
    const positions = playerPositions(player)
    const canOpen = player.playerId != null
    const rowStyle = [styles.rankRow, narrow && styles.rankRowNarrow]
    const rowTopStyle = [styles.rankRowTop, narrow && styles.rankRowTopNarrow]
    const rankNumberStyle = [styles.rankNumber, narrow && styles.rankNumberNarrow]
    // hashtagbasketball stacks the write-up directly beneath that player's stats
    // (same column); we mirror that — stats on top, comment on the line below.
    const commentNode = player.comment ? <Text style={styles.comment}>{player.comment}</Text> : null
    const valueRange = player.valueRange
    const valueText = valueRange
        ? `${valueRange.low}-${valueRange.high}`
        : String(player.selectedValue ?? '—')
    const confidenceText = player.confidence == null ? 'Unknown' : `${Math.round(player.confidence * 100)}%`
    const sourceText = (player.decisionSources?.map((source) => readableSourceName(source.name)).join(', ')) || readableSourceName(player.rankSource ?? '')
    const sourceFreshness = player.decisionSources
        ?.map((source) => source.fetchedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? player.rankFetchedAt
    const freshnessText = sourceFreshness && Date.parse(sourceFreshness) > 0 ? `Updated ${formatDate(sourceFreshness)}` : 'Not synced yet'

    // Draft-pick placeholders carry no player, stats, or headshot — they're
    // ranked slots (e.g. an incoming 2026 first-rounder), so render a slim row.
    if (player.isDraftPick) {
        return (
            <View style={rowStyle}>
                <View style={rowTopStyle}>
                    <View style={rankNumberStyle}>
                        <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
                        <RankMovement value={player.rankChange} />
                    </View>
                    <View style={styles.draftBadge}>
                        <MaterialIcons name="style" size={20} color={colors.primaryDark} />
                    </View>
                    <View style={styles.rankMain}>
                        <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                        <Text style={styles.draftLabel}>Future draft pick · Value {valueText}</Text>
                        <Text style={styles.decisionMeta}>Confidence {confidenceText} · {sourceText}</Text>
                        <Text style={styles.decisionMeta}>{freshnessText}</Text>
                        {player.missingInputs?.length ? (
                            <Text style={styles.missingText}>Range reflects missing {player.missingInputs.join(', ')}.</Text>
                        ) : null}
                    </View>
                </View>
            </View>
        )
    }

    return (
        <Pressable
            onPress={() => onPress(player)}
            disabled={!canOpen}
            style={rowStyle}
            accessibilityRole={canOpen ? 'button' : undefined}
            accessibilityLabel={canOpen ? `Open ${player.displayName}` : player.displayName}
        >
            <View style={rowTopStyle}>
                <View style={rankNumberStyle}>
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
                    <Text style={styles.valueText}>Value {valueText} · Confidence {confidenceText}</Text>
                    <Text style={styles.decisionMeta}>
                        Production {formatPoints(player.shortTermPoints ?? 0)} · Projection {formatPoints(player.projectionPoints ?? 0)} · Long term {player.longTermValue ?? 0}
                    </Text>
                    <Text style={styles.decisionMeta}>Source {sourceText} · {freshnessText}</Text>
                    {player.missingInputs?.length ? (
                        <Text style={styles.missingText}>Missing {player.missingInputs.join(', ')}</Text>
                    ) : null}
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
    const { width } = useWindowDimensions()
    const showStats = width >= WIDE_BREAKPOINT
    const narrowLayout = width < 760
    const [feed, setFeed] = useState<NewsFeed>('news')
    const { data: decisionMembers } = useFocusAsyncData(
        () => currentLeague ? getLeagueMembers(currentLeague.id) : Promise.resolve([]),
        [currentLeague?.id],
        { staleMs: 5 * 60_000 },
    )
    const rankings = useDynastyRankings({
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
            showStats={showStats}
            narrow={narrowLayout}
            onPress={handleOpenRankedPlayer}
        />
    ), [showStats, narrowLayout, handleOpenRankedPlayer])
    const cachedNews = readPersistentCache<DynastyNewsCache>(dynastyNewsCacheKey(user?.id, current?.id, currentLeague?.id)) ?? undefined
    const { data: newsData, loading: newsLoading, error: newsError, refresh: refreshNews } = useFocusAsyncData(
        async () => {
            const [news, myNews] = await Promise.all([
                getDynastyNews(30),
                current && currentLeague ? getMyDynastyNews(current.id, currentLeague.id, 30) : Promise.resolve(EMPTY_NEWS),
            ])
            const result = { news, myNews }
            writePersistentCache(dynastyNewsCacheKey(user?.id, current?.id, currentLeague?.id), result)
            return result
        },
        [current?.id, currentLeague?.id, user?.id],
        { staleMs: 5 * 60_000, initialData: cachedNews },
    )
    const news = newsData?.news ?? EMPTY_NEWS
    const myNews = newsData?.myNews ?? EMPTY_NEWS
    const activeNews = feed === 'my-news' ? myNews : news
    const activeNewsHydrated = !newsLoading || activeNews.length > 0
    const emptyNewsMessage = feed === 'my-news' ? 'No news for your players.' : 'No dynasty news yet.'
    const visibleSync = rankings.players.find((player) => Date.parse(player.rankFetchedAt) > 0)?.rankFetchedAt ?? null
    // A search that matches nothing has no rows to read the date from; keep the last one seen.
    const [knownSync, setKnownSync] = useState<string | null>(null)
    useEffect(() => {
        if (visibleSync && (!knownSync || Date.parse(visibleSync) > Date.parse(knownSync))) setKnownSync(visibleSync)
    }, [visibleSync, knownSync])
    const latestSync = visibleSync ?? knownSync
    const rankingFooter = rankings.loadingMore ? null : rankings.loadMoreError ? (
        <Pressable style={styles.footerRetry} onPress={() => void rankings.retryLoadMore()} accessibilityRole="button" accessibilityLabel="Retry rankings">
            <MaterialIcons name="refresh" size={16} color={colors.primaryDark} />
            <Text style={styles.footerRetryText}>Retry rankings</Text>
        </Pressable>
    ) : null

    return (
            <View style={[styles.contentWrap, { paddingHorizontal: padX }]}>
                <View style={styles.body}>
                {section === 'rankings' ? (
                    <>
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
                            <Text style={styles.syncText} numberOfLines={1}>
                                {rankings.refreshing ? 'Refreshing…' : latestSync ? `Updated ${formatDate(latestSync)}` : 'Not synced yet'}
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
                                key={rankings.view}
                                data={rankings.players}
                                extraData={[showStats, narrowLayout]}
                                keyExtractor={(player) => player.rankingId}
                                ItemSeparatorComponent={ItemSeparator}
                                contentContainerStyle={rankings.players.length === 0 && !rankings.loading ? styles.emptyContainer : undefined}
                                ListHeaderComponent={showStats ? <RankingsTableHeader /> : null}
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
                    </>
                ) : (
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
                        {newsError && activeNews.length === 0 ? (
                            <ErrorBanner message="Failed to load news. Tap to retry." onRetry={() => void refreshNews()} />
                        ) : null}
                        {/* Blank until hydrated — the card appears fully formed
                            instead of swapping a loading line for news rows. */}
                        {!activeNewsHydrated ? null : (
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
                        )}
                    </ScrollView>
                )}
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
    // Ranking views or news feeds on the left, freshness on the right. Full
    // width so the scrollable track has a definite size when it overflows.
    controlRow: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    syncText: { ...textStyles.meta, flexShrink: 0 },
    searchField: { flex: 1, maxWidth: 420 },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    tableHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        minHeight: table.headerHeight,
        paddingHorizontal: spacing.lg,
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
    // Narrow screens reclaim the wide-layout gutters so rows aren't squished.
    rankRowNarrow: { paddingHorizontal: spacing.xs },
    rankRowTopNarrow: { gap: spacing.md },
    rankNumberNarrow: { width: 30 },
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
    valueText: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    decisionMeta: { fontSize: fontSize.xs, lineHeight: 17, color: colors.textMuted },
    missingText: { fontSize: fontSize.xs, lineHeight: 17, color: colors.warningDark },
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
    compactStatLabel: { fontSize: fontSize['2xs'], fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 0.4 },
    compactStatValue: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
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

