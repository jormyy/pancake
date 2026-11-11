import { View, Text, StyleSheet } from 'react-native'
import { AssetList, tradeFlowItem } from '@/components/trades/TradeCard'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { formatLeagueDateTime } from '@/lib/timezone'
import type { TransactionRow } from '@/lib/transactions'
import type { TradeItem } from '@/lib/trades'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'

export function CompletedTradeActivityCard({ item, myMemberId, padX }: { item: TransactionRow; myMemberId?: string; padX: number }) {
    const timezone = useLeagueTimezone()
    const routed = [...item.tradePlayers ?? [], ...item.tradePicks ?? [], ...item.tradeFaab ?? []]
    const assets: TradeItem[] = routed.map(asset => asset.kind === 'player'
        ? { ...asset, position: asset.position ?? null, nbaTeam: asset.nbaTeam ?? null }
        : asset)
    const names = new Map<string, string>()
    if (item.memberId) names.set(item.memberId, item.teamName)
    if (item.targetMemberId && item.targetTeamName) names.set(item.targetMemberId, item.targetTeamName)
    for (const asset of routed) {
        if (asset.fromMemberId) names.set(asset.fromMemberId, asset.fromTeamName)
        if (asset.toMemberId) names.set(asset.toMemberId, asset.toTeamName)
    }
    for (const [index, name] of (item.participantTeamNames ?? []).entries()) {
        if (![...names.values()].includes(name)) names.set(`participant-${index}`, name)
    }
    const participants = [...names].map(([memberId, label]) => ({ memberId, label }))
    const pickContext = { viewerMemberId: myMemberId ?? '', memberNames: Object.fromEntries(names) }
    return (
        <View style={{ paddingHorizontal: padX, paddingVertical: spacing.sm }}>
            <View testID={`trade-activity-${item.id}`} style={styles.card}>
                <View style={styles.header}>
                    <Text style={styles.title}>Trade completed</Text>
                    <Text style={styles.time}>{formatLeagueDateTime(item.occurredAt, timezone)}</Text>
                </View>
                {assets.length === 0 ? (
                    <View style={{ gap: spacing.xs }}>
                        <Text style={styles.title}>{participants.map(team => team.label).join(' · ')}</Text>
                        <Text style={styles.fallback}>{item.body ?? 'Trade asset details are unavailable.'}</Text>
                    </View>
                ) : participants.length > 2 ? (
                    <MultiTeamTradeOverview compact participants={participants} pickContext={pickContext}
                        items={assets.map(tradeFlowItem).filter((asset): asset is TradeFlowItem => asset !== null)} />
                ) : participants.map(team => (
                    <AssetList key={team.memberId} label={`${team.label} receives`} stacked showContext={false}
                        items={assets.filter(asset => asset.toMemberId === team.memberId)} pickContext={pickContext} />
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm, minWidth: 0 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
    title: { ...textStyles.rowTitle },
    time: { ...textStyles.meta, color: colors.textMuted },
    fallback: { ...textStyles.meta },
})
