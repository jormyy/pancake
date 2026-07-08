import {
    View,
    Text,
    Pressable,
    StyleSheet,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { NoLeagueState } from '@/components/NoLeagueState'
import { isTradingClosed } from '@/lib/league'
import {
    addTradeBlockItem,
    getMyTrades,
    getTradeBlockItems,
    getVetoableTrades,
    removeTradeBlockItem,
    Trade,
    TradeBlockItem,
    TradePickItem,
    getPicksForMember,
} from '@/lib/trades'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { colors, fontSize, fontWeight, radii, spacing, layout, uiColors, INJURY_COLORS } from '@/constants/tokens'
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl'
import { ItemSeparator } from '@/components/ItemSeparator'
import { ErrorBanner } from '@/components/ui'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { formatPoints, playerHeadshotUrl, yearShort } from '@/lib/format'
import { TradeCard, TabKey } from '@/components/trades/TradeCard'
import { getErrorMessage } from '@/lib/alert'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'
import { Badge } from '@/components/Badge'

type ListItem =
    | { _type: 'trade'; trade: Trade }
    | { _type: 'header'; label: string }
    | { _type: 'empty'; key: string; message: string }
    | { _type: 'pick'; pick: TradePickItem }
    | { _type: 'blockItem'; item: TradeBlockItem }
    | { _type: 'blockPlayer'; player: RosterPlayer }
    | { _type: 'blockPick'; pick: TradePickItem }

type TradeBlockCache = {
    items: TradeBlockItem[]
    roster: RosterPlayer[]
}
const TRADES_CACHE_PREFIX = 'pancake:trades:v1:'
const PICKS_CACHE_PREFIX = 'pancake:trade-picks:v1:'
const TRADE_BLOCK_CACHE_PREFIX = 'pancake:trade-block:v1:'
const TRADE_LOADING_ROWS = 6

const tradesCacheKey = (memberId: string, leagueId: string) => `${TRADES_CACHE_PREFIX}${leagueId}:${memberId}`
const picksCacheKey = (memberId: string, leagueId: string) => `${PICKS_CACHE_PREFIX}${leagueId}:${memberId}`
const tradeBlockCacheKey = (memberId: string, leagueId: string) => `${TRADE_BLOCK_CACHE_PREFIX}${leagueId}:${memberId}`

// Module-level: these are pure functions of the row, no closures needed.
const listKeyExtractor = (item: ListItem, index: number) => {
    if (item._type === 'header') return `header-${index}`
    if (item._type === 'empty') return `empty-${item.key}`
    if (item._type === 'trade') return `trade-${item.trade.id}`
    if (item._type === 'blockItem') return `block-${item.item.id}`
    if (item._type === 'blockPlayer') return `block-player-${item.player.players.id}`
    if (item._type === 'blockPick') return `block-pick-${item.pick.pickId}`
    return `pick-${item.pick.pickId}`
}

const listGetItemType = (item: ListItem) => item._type

function TradeListPlaceholder({ tab }: { tab: TabKey }) {
    return (
        <View
            style={styles.placeholderList}
            role="status"
            aria-busy
            aria-label={`${tab} trades loading`}
            accessibilityLabel={`${tab} trades loading`}
            accessibilityState={{ busy: true }}
        >
            <View style={styles.placeholderSectionHeader}>
                <View style={styles.placeholderSectionTitle} />
            </View>
            {Array.from({ length: TRADE_LOADING_ROWS }, (_, index) => (
                <View key={index} style={styles.placeholderRow}>
                    <View style={styles.placeholderAvatar} />
                    <View style={styles.placeholderBody}>
                        <View style={styles.placeholderLineStrong} />
                        <View style={styles.placeholderLine} />
                    </View>
                    <View style={styles.placeholderAction} />
                </View>
            ))}
        </View>
    )
}

export default function TradesScreen() {
    const { push } = useRouter()
    const { current, currentLeague, memberships, loading: leagueLoading } = useLeagueContext()

    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const rosterSize: number = currentLeague?.roster_size ?? 20
    const myTeamName = current?.team_name ?? ''
    const tradingClosed = isTradingClosed(currentLeague)
    const cachedTrades = useMemo(
        () => myMemberId && leagueId ? readPersistentCache<Trade[]>(tradesCacheKey(myMemberId, leagueId)) : null,
        [myMemberId, leagueId],
    )
    const cachedPicks = useMemo(
        () => myMemberId && leagueId ? readPersistentCache<TradePickItem[]>(picksCacheKey(myMemberId, leagueId)) : null,
        [myMemberId, leagueId],
    )
    const cachedBlock = useMemo(
        () => myMemberId && leagueId ? readPersistentCache<TradeBlockCache>(tradeBlockCacheKey(myMemberId, leagueId)) : null,
        [myMemberId, leagueId],
    )

    const [tab, setTab] = useState<TabKey>('picks')
    const [trades, setTrades] = useState<Trade[]>(cachedTrades ?? [])
    const [loading, setLoading] = useState(!cachedTrades)
    const [tradesError, setTradesError] = useState<string | null>(null)
    const [blockItems, setBlockItems] = useState<TradeBlockItem[]>(cachedBlock?.items ?? [])
    const [blockRoster, setBlockRoster] = useState<RosterPlayer[]>(cachedBlock?.roster ?? [])
    const [blockAvgMap, setBlockAvgMap] = useState(EMPTY_AVG_MAP)
    const [blockAvgStatsMap, setBlockAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [blockLoading, setBlockLoading] = useState(!cachedBlock)
    const [blockError, setBlockError] = useState<string | null>(null)
    const [blockBusyId, setBlockBusyId] = useState<string | null>(null)
    const tradesLoadSeqRef = useRef(0)
    const blockLoadSeqRef = useRef(0)

    const { data: picks, loading: picksLoading, error: picksError } = useFocusAsyncData(async () => {
        if (!current || !leagueId) return [] as TradePickItem[]
        const result = await getPicksForMember(current.id, leagueId)
        writePersistentCache(picksCacheKey(current.id, leagueId), result)
        return result
    }, [current?.id, leagueId], { initialData: cachedPicks ?? undefined })

    const load = useCallback(async () => {
        const requestId = ++tradesLoadSeqRef.current
        const memberId = myMemberId
        const currentLeagueId = leagueId
        if (!memberId || !currentLeagueId) {
            setTrades([])
            setTradesError(null)
            setLoading(false)
            return
        }
        setTradesError(null)
        try {
            const [myTradeData, vetoableTradeData] = await Promise.all([
                getMyTrades(memberId, currentLeagueId),
                getVetoableTrades(memberId, currentLeagueId),
            ])
            if (tradesLoadSeqRef.current !== requestId) return
            const result = [...vetoableTradeData, ...myTradeData]
            setTrades(result)
            writePersistentCache(tradesCacheKey(memberId, currentLeagueId), result)
        } catch (e) {
            if (tradesLoadSeqRef.current !== requestId) return
            console.error(e)
            setTradesError(getErrorMessage(e) ?? 'Unknown error')
        } finally {
            if (tradesLoadSeqRef.current === requestId) setLoading(false)
        }
    }, [myMemberId, leagueId])

    const loadBlock = useCallback(async () => {
        const requestId = ++blockLoadSeqRef.current
        const memberId = myMemberId
        const currentLeagueId = leagueId
        if (!memberId || !currentLeagueId) {
            setBlockItems([])
            setBlockRoster([])
            setBlockAvgMap(EMPTY_AVG_MAP)
            setBlockAvgStatsMap(EMPTY_STATS_MAP)
            setBlockError(null)
            setBlockLoading(false)
            return
        }
        setBlockLoading(true)
        setBlockError(null)
        try {
            const [items, roster] = await Promise.all([
                getTradeBlockItems(currentLeagueId),
                getRoster(memberId, currentLeagueId),
            ])
            if (blockLoadSeqRef.current !== requestId) return
            const activeRoster = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
            const stats = await getRosterStatsMaps(activeRoster.map((player) => player.players.id), currentLeagueId)
            if (blockLoadSeqRef.current !== requestId) return
            setBlockItems(items)
            setBlockRoster(activeRoster)
            setBlockAvgMap(stats.avgMap)
            setBlockAvgStatsMap(stats.avgStatsMap)
            writePersistentCache(tradeBlockCacheKey(memberId, currentLeagueId), {
                items,
                roster: activeRoster,
            })
        } catch (e) {
            if (blockLoadSeqRef.current !== requestId) return
            console.error(e)
            setBlockError(getErrorMessage(e) ?? 'Unknown error')
        } finally {
            if (blockLoadSeqRef.current === requestId) setBlockLoading(false)
        }
    }, [myMemberId, leagueId])

    // Clear stale trades + show loading immediately when league/member changes,
    // so the previous league's accepted trades don't flash in the Veto Window
    // section while the new fetch is in-flight.
    useEffect(() => {
        const nextCachedTrades = myMemberId && leagueId
            ? readPersistentCache<Trade[]>(tradesCacheKey(myMemberId, leagueId))
            : null
        setTrades(nextCachedTrades ?? [])
        setLoading(!nextCachedTrades)
        const nextCachedBlock = myMemberId && leagueId
            ? readPersistentCache<TradeBlockCache>(tradeBlockCacheKey(myMemberId, leagueId))
            : null
        setBlockItems(nextCachedBlock?.items ?? [])
        setBlockRoster(nextCachedBlock?.roster ?? [])
        setBlockAvgMap(EMPTY_AVG_MAP)
        setBlockAvgStatsMap(EMPTY_STATS_MAP)
        setBlockLoading(!nextCachedBlock)
    }, [myMemberId, leagueId])

    useEffect(() => {
        load()
    }, [load])

    useEffect(() => {
        if (tab === 'block') void loadBlock()
    }, [tab, loadBlock])

    const handleListPlayer = useCallback(async (player: RosterPlayer) => {
        if (!myMemberId || !leagueId) return
        setBlockBusyId(player.players.id)
        try {
            await addTradeBlockItem({ memberId: myMemberId, leagueId, playerId: player.players.id })
            await loadBlock()
        } catch (e) {
            setBlockError(getErrorMessage(e) ?? 'Could not update trade block.')
        } finally {
            setBlockBusyId(null)
        }
    }, [myMemberId, leagueId, loadBlock])

    const handleListPick = useCallback(async (pick: TradePickItem) => {
        if (!myMemberId || !leagueId) return
        setBlockBusyId(pick.pickId)
        try {
            await addTradeBlockItem({ memberId: myMemberId, leagueId, pickId: pick.pickId })
            await loadBlock()
        } catch (e) {
            setBlockError(getErrorMessage(e) ?? 'Could not update trade block.')
        } finally {
            setBlockBusyId(null)
        }
    }, [myMemberId, leagueId, loadBlock])

    const handleRemoveBlockItem = useCallback(async (item: TradeBlockItem) => {
        if (!myMemberId) return
        setBlockBusyId(item.id)
        try {
            await removeTradeBlockItem(item.id, myMemberId)
            await loadBlock()
        } catch (e) {
            setBlockError(getErrorMessage(e) ?? 'Could not update trade block.')
        } finally {
            setBlockBusyId(null)
        }
    }, [myMemberId, loadBlock])

    const incomingTrades = useMemo(() => trades.filter(
        (t) => t.recipientMemberId === myMemberId && t.status === 'pending',
    ), [trades, myMemberId])
    const outgoingTrades = useMemo(() => trades.filter(
        (t) => t.proposerMemberId === myMemberId && t.status === 'pending',
    ), [trades, myMemberId])
    const vetoableTrades = useMemo(() => trades.filter(
        (t) => t.status === 'accepted' && t.proposerMemberId !== myMemberId && t.recipientMemberId !== myMemberId,
    ), [trades, myMemberId])
    const historyTrades = useMemo(() => trades.filter(
        (t) => t.status !== 'pending' && (t.proposerMemberId === myMemberId || t.recipientMemberId === myMemberId),
    ), [trades, myMemberId])

    const picksList = useMemo(() => picks ?? [], [picks])
    const myBlockItems = useMemo(
        () => blockItems.filter((item) => item.memberId === myMemberId),
        [blockItems, myMemberId],
    )
    const publicBlockItems = useMemo(
        () => blockItems.filter((item) => item.memberId !== myMemberId),
        [blockItems, myMemberId],
    )

    const renderItem = useCallback(({ item }: { item: ListItem }) => {
        if (item._type === 'header') {
            return item.label ? <SectionHeader label={item.label} /> : null
        }
        if (item._type === 'empty') {
            return (
                <View style={styles.blockEmptyRow}>
                    <Text style={styles.blockEmptyText}>{item.message}</Text>
                </View>
            )
        }
        if (item._type === 'pick') {
            const isOwn = item.pick.originalTeamName === myTeamName
            return (
                <View style={styles.pickRow}>
                    <View style={styles.pickCircle}>
                        <Text style={styles.pickCircleText}>
                            {yearShort(item.pick.seasonYear)}
                        </Text>
                    </View>
                    <Text style={styles.pickLabel}>
                        Round {item.pick.round}
                    </Text>
                    <View style={styles.pickSpacer} />
                    <View style={[styles.pickChip, !isOwn && styles.pickChipTraded]}>
                        <Text style={styles.pickChipText} numberOfLines={1}>
                            {isOwn ? 'Own pick' : `From ${item.pick.originalTeamName}`}
                        </Text>
                    </View>
                </View>
            )
        }
        if (item._type === 'blockItem') {
            const block = item.item
            const mine = block.memberId === myMemberId
            const label = block.asset.kind === 'player'
                ? block.asset.playerName
                : `${block.asset.seasonYear} Round ${block.asset.round} pick`
            const positions = block.asset.kind === 'player'
                ? block.asset.eligiblePositions?.length
                    ? block.asset.eligiblePositions
                    : block.asset.position
                      ? [block.asset.position]
                      : []
                : []
            const yearsLabel = block.asset.kind === 'player'
                ? block.asset.yearsExp == null ? null
                    : block.asset.yearsExp <= 0 ? 'Rookie'
                    : `${block.asset.yearsExp} YR`
                : null
            const statText = block.asset.kind === 'player'
                ? [
                    block.asset.avgFantasyPoints != null ? `${formatPoints(block.asset.avgFantasyPoints)} FPts` : null,
                    block.asset.avgMinutesPlayed != null ? `${formatPoints(block.asset.avgMinutesPlayed)} MIN` : null,
                    yearsLabel,
                ].filter(Boolean).join(' · ')
                : ''
            return (
                <View style={styles.blockRow}>
                    {block.asset.kind === 'player' ? (
                        <Avatar
                            name={block.asset.playerName}
                            uri={playerHeadshotUrl(block.asset.nbaId) ?? undefined}
                            color={colors.bgMuted}
                            textColor={colors.textSecondary}
                            size={38}
                        />
                    ) : null}
                    <View style={styles.blockInfo}>
                        <Text style={styles.blockTitle}>{label}</Text>
                        {block.asset.kind === 'player' ? (
                            <>
                                <View style={styles.blockMetaRow}>
                                    <Text style={styles.blockMeta}>{block.teamName}</Text>
                                    {block.asset.nbaTeam ? <Text style={styles.blockMeta}>{block.asset.nbaTeam}</Text> : null}
                                    {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                                    {block.asset.injuryStatus ? (
                                        <Badge
                                            label={block.asset.injuryStatus}
                                            color={INJURY_COLORS[block.asset.injuryStatus] ?? colors.textMuted}
                                            variant="solid"
                                        />
                                    ) : null}
                                </View>
                                <Text style={styles.blockContext} numberOfLines={1}>{statText || 'No season stats'}</Text>
                            </>
                        ) : (
                            <Text style={styles.blockMeta}>{block.teamName}</Text>
                        )}
                        {block.note ? <Text style={styles.blockNote}>{block.note}</Text> : null}
                    </View>
                    {mine ? (
                        <Pressable
                            style={styles.blockAction}
                            onPress={() => handleRemoveBlockItem(block)}
                            disabled={blockBusyId === block.id}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${label} from trade block`}
                        >
                            <Text style={styles.blockActionText}>Remove</Text>
                        </Pressable>
                    ) : (
                        <Pressable
                            style={styles.blockAction}
                            onPress={() => push({
                                pathname: '/(modals)/propose-trade',
                                params: {
                                    recipientMemberId: block.memberId,
                                    requestPlayerId: block.asset.kind === 'player' ? block.asset.playerId : undefined,
                                    requestPickId: block.asset.kind === 'pick' ? block.asset.pickId : undefined,
                                },
                            })}
                            accessibilityRole="button"
                            accessibilityLabel={`Offer for ${label}`}
                        >
                            <Text style={styles.blockActionText}>Offer</Text>
                        </Pressable>
                    )}
                </View>
            )
        }
        if (item._type === 'blockPlayer') {
            const listed = blockItems.some((block) => block.memberId === myMemberId && block.asset.kind === 'player' && block.asset.playerId === item.player.players.id)
            const player = item.player.players
            const positions = player.eligible_positions?.length
                ? player.eligible_positions
                : player.position
                  ? [player.position]
                  : []
            const yearsLabel =
                player.years_exp == null ? null
                : player.years_exp <= 0 ? 'Rookie'
                : `${player.years_exp} YR`
            const statText = [
                blockAvgMap.get(player.id) != null ? `${formatPoints(blockAvgMap.get(player.id))} FPts` : null,
                blockAvgStatsMap.get(player.id)?.avg_minutes_played != null ? `${formatPoints(blockAvgStatsMap.get(player.id)?.avg_minutes_played)} MIN` : null,
                yearsLabel,
            ].filter(Boolean).join(' · ')
            return (
                <View style={styles.blockRow}>
                    <Avatar
                        name={player.display_name}
                        uri={playerHeadshotUrl(player.nba_id) ?? undefined}
                        color={colors.bgMuted}
                        textColor={colors.textSecondary}
                        size={38}
                    />
                    <View style={styles.blockInfo}>
                        <Text style={styles.blockTitle}>{player.display_name}</Text>
                        <View style={styles.blockMetaRow}>
                            {player.nba_team ? <Text style={styles.blockMeta}>{player.nba_team}</Text> : null}
                            {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                            {player.injury_status ? (
                                <Badge
                                    label={player.injury_status}
                                    color={INJURY_COLORS[player.injury_status] ?? colors.textMuted}
                                    variant="solid"
                                />
                            ) : null}
                        </View>
                        <Text style={styles.blockContext} numberOfLines={1}>{statText || 'No season stats'}</Text>
                    </View>
                    <Pressable
                        style={[styles.blockAction, listed && styles.blockActionDisabled]}
                        onPress={() => handleListPlayer(item.player)}
                        disabled={listed || blockBusyId === player.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${listed ? 'Listed' : 'List'} ${player.display_name} on trade block`}
                        accessibilityState={{ disabled: listed || blockBusyId === player.id }}
                    >
                        <Text style={styles.blockActionText}>{listed ? 'Listed' : 'List'}</Text>
                    </Pressable>
                </View>
            )
        }
        if (item._type === 'blockPick') {
            const listed = blockItems.some((block) => block.memberId === myMemberId && block.asset.kind === 'pick' && block.asset.pickId === item.pick.pickId)
            return (
                <View style={styles.blockRow}>
                    <View style={styles.blockInfo}>
                        <Text style={styles.blockTitle}>{item.pick.seasonYear} Round {item.pick.round}</Text>
                        <Text style={styles.blockMeta}>via {item.pick.originalTeamName}</Text>
                    </View>
                    <Pressable
                        style={[styles.blockAction, listed && styles.blockActionDisabled]}
                        onPress={() => handleListPick(item.pick)}
                        disabled={listed || blockBusyId === item.pick.pickId}
                        accessibilityRole="button"
                        accessibilityLabel={`${listed ? 'Listed' : 'List'} ${item.pick.seasonYear} round ${item.pick.round} pick on trade block`}
                        accessibilityState={{ disabled: listed || blockBusyId === item.pick.pickId }}
                    >
                        <Text style={styles.blockActionText}>{listed ? 'Listed' : 'List'}</Text>
                    </Pressable>
                </View>
            )
        }
        return (
            <TradeCard
                trade={item.trade}
                myMemberId={myMemberId}
                leagueId={leagueId}
                rosterSize={rosterSize}
                tab={tab}
                onAction={load}
            />
        )
    }, [
        myTeamName,
        myMemberId,
        leagueId,
        rosterSize,
        tab,
        load,
        blockItems,
        blockBusyId,
        blockAvgMap,
        blockAvgStatsMap,
        handleListPlayer,
        handleListPick,
        handleRemoveBlockItem,
        push,
    ])

    const listData = useMemo<ListItem[]>(() => {
        const result: ListItem[] = []

        if (tab === 'picks') {
            // Group picks under a year header so the long pick bank is scannable.
            const sorted = [...picksList].sort((a, b) => a.seasonYear - b.seasonYear || a.round - b.round || a.originalTeamName.localeCompare(b.originalTeamName) || a.pickId.localeCompare(b.pickId))
            let lastYear: number | null = null
            sorted.forEach((p) => {
                if (p.seasonYear !== lastYear) {
                    result.push({ _type: 'header', label: `${p.seasonYear} Picks` })
                    lastYear = p.seasonYear
                }
                result.push({ _type: 'pick', pick: p })
            })
        } else if (tab === 'offers') {
            // Veto Window only appears while there are league trades to veto,
            // so it never renders as a bare header with nothing beneath it.
            if (vetoableTrades.length > 0) {
                result.push({ _type: 'header', label: 'Veto Window' })
                vetoableTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            }
            result.push({ _type: 'header', label: 'Incoming' })
            incomingTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (incomingTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
            result.push({ _type: 'header', label: 'Outgoing' })
            outgoingTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (outgoingTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
        } else if (tab === 'block') {
            result.push({ _type: 'header', label: 'Your Listings' })
            myBlockItems.forEach((item) => result.push({ _type: 'blockItem', item }))
            if (myBlockItems.length === 0 && !blockLoading) {
                result.push({ _type: 'empty', key: 'my-block-listings', message: 'No listings yet.' })
            }
            result.push({ _type: 'header', label: 'List Your Players' })
            blockRoster.forEach((player) => result.push({ _type: 'blockPlayer', player }))
            result.push({ _type: 'header', label: 'List Your Picks' })
            picksList.forEach((pick) => result.push({ _type: 'blockPick', pick }))
            result.push({ _type: 'header', label: 'League Trade Block' })
            publicBlockItems.forEach((item) => result.push({ _type: 'blockItem', item }))
            if (publicBlockItems.length === 0 && !blockLoading) {
                result.push({ _type: 'empty', key: 'league-block-listings', message: 'No league listings yet.' })
            }
        } else {
            result.push({ _type: 'header', label: 'Trade History' })
            historyTrades.forEach((t) => result.push({ _type: 'trade', trade: t }))
            if (historyTrades.length === 0 && !loading) {
                result.push({ _type: 'header', label: '' })
            }
        }

        return result
    }, [tab, vetoableTrades, incomingTrades, outgoingTrades, historyTrades, picksList, loading, myBlockItems, blockLoading, blockRoster, publicBlockItems])

    const pendingInboxCount = incomingTrades.length
    const picksHydrated = !picksLoading || picksList.length > 0
    const tradesHydrated = !loading || trades.length > 0
    const blockHydrated = !blockLoading || blockItems.length > 0 || blockRoster.length > 0
    const activeTabHydrated =
        tab === 'picks' ? picksHydrated
        : tab === 'block' ? blockHydrated
        : tradesHydrated

    const tabOptions: SegmentOption<TabKey>[] = [
        { label: 'Picks', value: 'picks' },
        { label: 'Offers', value: 'offers', badge: pendingInboxCount > 0 ? pendingInboxCount : undefined },
        { label: 'Block', value: 'block' },
        { label: 'History', value: 'history' },
    ]

    if (memberships.length === 0 && leagueLoading) {
        return (
            <SafeAreaView style={styles.container}>
              <View style={styles.content}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle} role="heading" aria-level={1}>Trades</Text>
                    <View style={[styles.proposeBtn, styles.placeholderProposeBtn]} />
                </View>
                <View style={styles.tabRow}>
                    <SegmentedControl
                        options={tabOptions}
                        value={tab}
                        onChange={setTab}
                        accessibilityLabel="Trade sections"
                        scrollable
                    />
                </View>
                <TradeListPlaceholder tab={tab} />
              </View>
            </SafeAreaView>
        )
    }
    if (memberships.length === 0) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
          <View style={styles.content}>
            <View style={styles.header}>
                <Text style={styles.headerTitle} role="heading" aria-level={1}>Trades</Text>
                <Pressable
                    style={[styles.proposeBtn, tradingClosed && styles.proposeBtnDisabled]}
                    onPress={() => push('/(modals)/propose-trade')}
                    disabled={tradingClosed}
                    accessibilityRole="button"
                    accessibilityLabel={tradingClosed ? 'Trades unavailable' : 'Propose trade'}
                    accessibilityState={{ disabled: tradingClosed }}
                >
                    <Text style={[styles.proposeBtnText, tradingClosed && styles.proposeBtnTextDisabled]}>
                        {tradingClosed ? 'Locked' : '+ Propose'}
                    </Text>
                </Pressable>
            </View>

            <View style={styles.tabRow}>
                <SegmentedControl
                    options={tabOptions}
                    value={tab}
                    onChange={setTab}
                    accessibilityLabel="Trade sections"
                    scrollable
                />
            </View>

            {(tradesError || picksError || blockError) ? (
                <ErrorBanner
                    message="Failed to load trades. Tap to retry."
                    onRetry={() => { void load(); if (tab === 'block') void loadBlock() }}
                />
            ) : null}

            {!activeTabHydrated ? <TradeListPlaceholder tab={tab} /> : tab === 'picks' && picksError ? (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyStateText}>Error: {picksError.message}</Text>
                </View>
            ) : tab === 'picks' && picksList.length === 0 ? (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyStateText}>No draft picks</Text>
                </View>
            ) : (
                <FlashList
                    data={listData}
                    keyExtractor={listKeyExtractor}
                    getItemType={listGetItemType}
                    ItemSeparatorComponent={ItemSeparator}
                    renderItem={renderItem}
                />
            )}
          </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    content: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
    container: { flex: 1, backgroundColor: colors.bgScreen },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    proposeBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.lg,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 90,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    proposeBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    proposeBtnDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    proposeBtnTextDisabled: { color: colors.textPlaceholder },
    placeholderProposeBtn: {
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },

    tabRow: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    placeholderList: {
        flex: 1,
    },
    placeholderSectionHeader: {
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    placeholderSectionTitle: {
        width: 142,
        height: 12,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
    placeholderRow: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    placeholderAvatar: {
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    placeholderBody: {
        flex: 1,
        minWidth: 0,
        gap: spacing.sm,
    },
    placeholderLineStrong: {
        width: '48%',
        maxWidth: 220,
        height: 14,
        borderRadius: radii.xs,
        backgroundColor: colors.bgMuted,
    },
    placeholderLine: {
        width: '34%',
        maxWidth: 160,
        height: 11,
        borderRadius: radii.xs,
        backgroundColor: colors.bgSubtle,
    },
    placeholderAction: {
        width: 72,
        height: 36,
        borderRadius: radii.md,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
        // Cap the row like other constrained columns so the provenance pill
        // sits near the pick info instead of orphaned at the far right edge.
        width: '100%',
        maxWidth: 760,
    },
    pickCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.neutralSolid,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    pickLabel: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary, minWidth: 84 },
    pickSpacer: { flex: 1 },
    pickChip: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    pickChipTraded: { backgroundColor: colors.primaryLight },
    pickChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    pickHint: { fontSize: 12, color: colors.primaryDark, fontWeight: fontWeight.bold },
    blockEmptyRow: {
        minHeight: 56,
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    blockEmptyText: { fontSize: fontSize.sm, color: colors.textMuted },
    blockRow: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
    },
    blockInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    blockTitle: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    blockMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
    blockMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    blockContext: { fontSize: fontSize.xs, color: colors.primaryDark, fontWeight: fontWeight.bold },
    blockNote: { fontSize: fontSize.sm, color: colors.textSecondary },
    blockAction: {
        minWidth: 72,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primary,
        paddingHorizontal: spacing.md,
    },
    blockActionDisabled: {
        borderColor: colors.borderLight,
        backgroundColor: colors.bgMuted,
    },
    blockActionText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },

    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: spacing['4xl'] },
    emptyStateText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})
