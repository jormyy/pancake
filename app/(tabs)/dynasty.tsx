import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useMemo, useState } from 'react'
import {
    ActivityIndicator,
    Linking,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { EmptyState } from '@/components/EmptyState'
import { Card, Input, SegmentedControl } from '@/components/ui'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getDynastyNews, getDynastyRankings, type DynastyNewsItem, type DynastyRankPlayer } from '@/lib/dynasty'
import { getEligiblePositions } from '@/lib/players'
import { colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'

type DynastyTab = 'rankings' | 'news'
const EMPTY_RANKINGS: DynastyRankPlayer[] = []
const EMPTY_NEWS: DynastyNewsItem[] = []

function formatDate(value: string | null): string {
    if (!value) return 'Not synced'
    return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function rankTier(rank: number): string {
    if (rank <= 12) return 'Cornerstone'
    if (rank <= 36) return 'Core'
    if (rank <= 75) return 'Upside'
    return 'Depth'
}

function RankingRow({ player, onPress }: { player: DynastyRankPlayer; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} style={styles.rankRow} accessibilityRole="button" accessibilityLabel={`Open ${player.displayName}`}>
            <View style={styles.rankNumber}>
                <Text style={styles.rankNumberText}>{player.dynastyRank}</Text>
            </View>
            <View style={styles.rankMain}>
                <View style={styles.rankTitleRow}>
                    <Text style={styles.playerName} numberOfLines={1}>{player.displayName}</Text>
                    <Text style={styles.rankTier}>{rankTier(player.dynastyRank)}</Text>
                </View>
                <View style={styles.metaRow}>
                    {player.nbaTeam ? <Text style={styles.metaText}>{player.nbaTeam}</Text> : null}
                    {getEligiblePositions({ eligible_positions: player.eligiblePositions, position: player.position }).map((pos) => (
                        <Text key={pos} style={styles.positionPill}>{pos}</Text>
                    ))}
                    {player.yearsExp === 0 ? <Text style={styles.rookieText}>Rookie</Text> : null}
                    {player.injuryStatus ? <Text style={styles.metaText}>{player.injuryStatus}</Text> : null}
                </View>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.textPlaceholder} />
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
                <Text style={styles.newsPlayer}>{item.playerName}{item.playerTeam ? ` · ${item.playerTeam}` : ''}</Text>
            ) : null}
        </Pressable>
    )
}

export default function DynastyScreen() {
    const router = useRouter()
    const [tab, setTab] = useState<DynastyTab>('rankings')
    const [query, setQuery] = useState('')
    const {
        data,
        loading,
        refreshing,
        refresh,
    } = useFocusAsyncData(
        async () => {
            const [rankings, news] = await Promise.all([
                getDynastyRankings(125),
                getDynastyNews(30),
            ])
            return { rankings, news }
        },
        [],
        { staleMs: 5 * 60_000 },
    )

    const rankings = data?.rankings ?? EMPTY_RANKINGS
    const news = data?.news ?? EMPTY_NEWS
    const filteredRankings = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return rankings
        return rankings.filter((player) =>
            player.displayName.toLowerCase().includes(q) ||
            player.nbaTeam?.toLowerCase().includes(q) ||
            player.position?.toLowerCase().includes(q),
        )
    }, [query, rankings])
    const latestSync = rankings.find((player) => player.rankFetchedAt)?.rankFetchedAt ?? null

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                contentContainerStyle={styles.content}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
            >
                <View style={styles.header}>
                    <View>
                        <Text style={styles.title}>Dynasty Hub</Text>
                        <Text style={styles.subtitle}>Rankings and player movement</Text>
                    </View>
                    {loading ? <ActivityIndicator color={colors.primary} /> : (
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
                        { label: 'Rankings', value: 'rankings', badge: rankings.length },
                        { label: 'News', value: 'news', badge: news.length },
                    ]}
                    scrollable
                />

                {tab === 'rankings' ? (
                    <>
                        <Input
                            value={query}
                            onChangeText={setQuery}
                            placeholder="Search dynasty rankings"
                            leftIcon="search"
                            autoCorrect={false}
                        />
                        <Card padding="md" radius="md" elevated="none" style={styles.listCard}>
                            {loading && rankings.length === 0 ? (
                                <ActivityIndicator color={colors.primary} style={styles.loadingBlock} />
                            ) : filteredRankings.length === 0 ? (
                                <EmptyState message="No ranked players found." fullScreen={false} />
                            ) : (
                                filteredRankings.map((player, index) => (
                                    <View key={player.id}>
                                        <RankingRow
                                            player={player}
                                            onPress={() => router.push(`/player/${player.id}`)}
                                        />
                                        {index < filteredRankings.length - 1 ? <View style={styles.separator} /> : null}
                                    </View>
                                ))
                            )}
                        </Card>
                    </>
                ) : (
                    <Card padding="md" radius="md" elevated="none" style={styles.listCard}>
                        {loading && news.length === 0 ? (
                            <ActivityIndicator color={colors.primary} style={styles.loadingBlock} />
                        ) : news.length === 0 ? (
                            <EmptyState message="No dynasty news yet." fullScreen={false} />
                        ) : (
                            news.map((item, index) => (
                                <View key={item.id}>
                                    <NewsRow item={item} />
                                    {index < news.length - 1 ? <View style={styles.separator} /> : null}
                                </View>
                            ))
                        )}
                    </Card>
                )}
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    content: {
        width: '100%',
        maxWidth: layout.contentMaxWidth,
        alignSelf: 'center',
        padding: spacing.xl,
        gap: spacing.xl,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.lg,
    },
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
    listCard: { overflow: 'hidden' },
    rankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md,
    },
    rankNumber: {
        width: 44,
        height: 44,
        borderRadius: radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primaryLight,
    },
    rankNumberText: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    rankMain: { flex: 1, minWidth: 0, gap: spacing.xs },
    rankTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    playerName: { flex: 1, minWidth: 0, fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    rankTier: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
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
    rookieText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.successDark },
    newsRow: { paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: spacing.sm },
    newsTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
    newsSource: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textTransform: 'uppercase' },
    newsDate: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    newsTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    newsSummary: { fontSize: fontSize.md, lineHeight: 20, color: colors.textSecondary },
    newsPlayer: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    separator: { height: 1, backgroundColor: colors.borderLight },
    loadingBlock: { paddingVertical: spacing['5xl'] },
})
