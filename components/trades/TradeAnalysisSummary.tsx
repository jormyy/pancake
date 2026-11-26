import { orderTradeAssets, tradeAnalysisAssetOrder } from '@/lib/trade-assets'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import { SectionBand } from '@/components/ui/SectionBand'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { RosterPlayer } from '@/lib/roster'
import type { DynastyTradeAnalysis } from '@/core/src/dynasty/decisionEngine'
import { curveTradeValue } from '@/core/src/dynasty/tradeScoring'
import { curvedAssetValue, tradeComparison, formatTradeValue } from '@/lib/trade-estimates'
import { borderWidth, colors, componentTokens, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'

export function TradeAnalysisSummary({
    analysis,
    players = [],
    participantName,
    loading = false,
    inset = true,
}: {
    analysis: DynastyTradeAnalysis | null
    players?: RosterPlayer[]
    participantName: (memberId: string) => string
    loading?: boolean
    cached?: boolean
    /** Outer margin for full-width placement; a side column sets this false. */
    inset?: boolean
    calculatedAt?: string
    saved?: boolean
}) {
    if (loading) return (
        <View style={[styles.pending, inset && styles.inset]} accessibilityLabel="Updating trade values" accessibilityLiveRegion="polite" aria-busy>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.assetValue}>Updating values…</Text>
        </View>
    )
    if (!analysis) return null

    const comparison = tradeComparison(analysis.teams)
    const winner = comparison.winnerMemberId ? participantName(comparison.winnerMemberId) : null
    return (
        <View style={[styles.card, inset && styles.inset]} accessibilityLabel="Dynasty trade analysis" aria-busy={loading}>
            <SectionBand label={winner ? `${winner} wins` : 'Fair trade'}
                detail={<Text style={styles.bandDetail} numberOfLines={1}>{formatTradeValue(comparison.gapPercent)}% gap</Text>} />
            <View style={styles.body}>
                {analysis.teams.map((team) => {
                    const net = team.netValue ?? team.valuesReceived - team.valuesSent + team.rosterSlotEffect
                    return (
                        <View key={team.memberId} style={styles.teamRow}>
                            <View style={styles.teamHeading}>
                                <Text style={styles.teamName} numberOfLines={1}>{participantName(team.memberId)}</Text>
                                <Text style={styles.value} numberOfLines={1}>{formatTradeValue(team.adjustedValue ?? team.valuesReceived + team.rosterSlotEffect)}</Text>
                            </View>
                            <View style={styles.teamHeading}>
                                <Text style={[styles.detail, styles.teamTotals]} numberOfLines={1}>Received {formatTradeValue(team.valuesReceived)} · Sent {formatTradeValue(team.valuesSent)} · Cuts {signed(team.rosterSlotEffect)}</Text>
                                <Text style={[styles.detail, styles.fixed, net < 0 && styles.valueNegative]} numberOfLines={1}>Net {signed(net)}</Text>
                            </View>
                        </View>
                    )
                })}
                <Text style={styles.detail}>Curved package totals · required cuts included</Text>
                <View>
                    {orderTradeAssets(analysis.assets, tradeAnalysisAssetOrder).map((asset) => {
                        const player = players.find(item => item.players.id === asset.assetId)?.players
                        return (
                            <View key={`${asset.kind}:${asset.assetId}`} style={styles.assetRow}>
                                <View style={styles.assetHeading}>
                                    {asset.kind === 'player' ? <TradePlayerLink compact playerId={asset.assetId} name={asset.label} nbaId={player?.nba_id} team={player?.nba_team}
                                        positions={player?.eligible_positions ?? (player?.position ? [player.position] : [])}
                                        injuryStatus={player?.injury_status} yearsExp={player?.years_exp} careerGames={player?.career_regular_season_games}
                                        stats={<Text style={styles.assetValue} numberOfLines={1} adjustsFontSizeToFit>{assetValueLine(asset, analysis.strategy)}</Text>} /> : <View style={styles.assetCopy}>
                                        <Text style={styles.assetName} numberOfLines={1}>{asset.label}</Text>
                                        <Text style={styles.assetValue} numberOfLines={1} adjustsFontSizeToFit>{assetValueLine(asset, analysis.strategy)}</Text>
                                    </View>}
                                </View>
                            </View>
                        )
                    })}
                </View>
            </View>
        </View>
    )
}

function assetValueLine(asset: DynastyTradeAnalysis['assets'][number], strategy: DynastyTradeAnalysis['strategy']): string {
    const range = asset.ranges[strategy]
    return `Trade value ${formatTradeValue(curvedAssetValue(asset, strategy))} · Source ${formatTradeValue(asset.values[strategy])}${range ? ` · ${formatTradeValue(curveTradeValue(range.low))}–${formatTradeValue(curveTradeValue(range.high))}` : ''}`
}

function signed(value: number): string {
    if (value > 0) return `+${formatTradeValue(value)}`
    return formatTradeValue(value)
}

const styles = StyleSheet.create({
    pending: { minHeight: componentTokens.tradeAnalyzer.pendingHeight, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    inset: { marginHorizontal: spacing.lg, marginVertical: spacing.md },
    card: {
        borderWidth: borderWidth.thin,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
    },
    body: { padding: spacing.lg, gap: spacing.md },
    teamRow: { gap: spacing.xxs },
    bandDetail: { ...typeScale.caption, fontWeight: fontWeight.bold, color: colors.textMuted, fontVariant: ['tabular-nums'] },
    teamHeading: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm, minWidth: 0 },
    teamName: { ...typeScale.row, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.bold, color: colors.textPrimary },
    teamTotals: { flexShrink: 1, minWidth: 0 },
    fixed: { flexShrink: 0 },
    value: { ...typeScale.row, flexShrink: 0, fontWeight: fontWeight.bold, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    valueNegative: { color: colors.dangerDark },
    detail: { ...typeScale.caption, color: colors.textSecondary },
    assetRow: { gap: spacing.xxs, paddingVertical: spacing.sm, borderTopWidth: borderWidth.thin, borderTopColor: colors.borderLight },
    assetHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    assetValue: { ...textStyles.meta, ...typeScale.caption, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    assetCopy: { flex: 1, minWidth: 0 },
    assetName: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
