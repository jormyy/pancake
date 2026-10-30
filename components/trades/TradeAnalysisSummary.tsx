import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { RosterPlayer } from '@/lib/roster'
import type { DynastyTradeAnalysis } from '@/core/src/dynasty/decisionEngine'
import { curveTradeValue } from '@/core/src/dynasty/tradeScoring'
import { curvedAssetValue, tradeComparison, formatTradeValue } from '@/lib/trade-estimates'
import { borderWidth, colors, componentTokens, fontSize, fontWeight, spacing, textStyles, lineHeight } from '@/constants/tokens'

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
        <View style={[styles.root, inset && styles.inset]} accessibilityLabel="Dynasty trade analysis" aria-busy={loading}>
            <Text style={styles.verdict}>{winner ? `${winner} wins` : 'Fair'} · {formatTradeValue(comparison.gapPercent)}% gap</Text>
            <Text style={styles.detail}>Curved package totals · roster spots included</Text>
            <View style={styles.teamGrid}>
                {analysis.teams.map((team) => (
                    <View key={team.memberId} style={styles.teamCard}>
                        <Text style={styles.teamName}>{participantName(team.memberId)}</Text>
                        <View style={styles.teamHeading}>
                            <Text style={styles.value}>{formatTradeValue(team.adjustedValue ?? team.valuesReceived + team.rosterSlotEffect)}</Text>
                            <Text style={[styles.detail, (team.netValue ?? team.impact) < 0 && styles.valueNegative]}>Net {signed(team.netValue ?? team.valuesReceived - team.valuesSent + team.rosterSlotEffect)}</Text>
                        </View>
                        <Text style={styles.detail}>Received {formatTradeValue(team.valuesReceived)} · Sent {formatTradeValue(team.valuesSent)} · Spots {signed(team.rosterSlotEffect)}</Text>
                    </View>
                ))}
            </View>
            {analysis.assets.map((asset) => {
                const player = players.find(item => item.players.id === asset.assetId)?.players
                return (
                <View key={`${asset.kind}:${asset.assetId}`} style={styles.assetRow}>
                    <View style={styles.assetHeading}>
                        {asset.kind === 'player' ? <PlayerRowContent compact name={asset.label} nbaId={player?.nba_id} team={player?.nba_team}
                            positions={player?.eligible_positions ?? (player?.position ? [player.position] : [])}
                            injuryStatus={player?.injury_status}
                            stats={<Text style={styles.assetValue} numberOfLines={1} adjustsFontSizeToFit>{assetValueLine(asset, analysis.strategy)}</Text>} /> : <View style={styles.assetCopy}>
                            <Text style={styles.assetName} numberOfLines={1}>{asset.label}</Text>
                            <Text style={styles.assetValue} numberOfLines={1} adjustsFontSizeToFit>{assetValueLine(asset, analysis.strategy)}</Text>
                        </View>}
                    </View>
                </View>
                )
            })}
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
    inset: { margin: spacing.xl },
    root: { gap: spacing.md },
    teamGrid: { gap: spacing.xs },
    teamCard: { alignItems: 'stretch', minHeight: componentTokens.playerRow.compact.minHeight, paddingHorizontal: componentTokens.playerRow.compact.paddingHorizontal, gap: spacing.md, width: '100%' },
    verdict: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    teamHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
    teamName: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    value: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primaryDark },
    valueNegative: { color: colors.dangerDark },
    detail: { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: lineHeight.body },
    assetRow: { gap: spacing.xxs, paddingVertical: spacing.sm, borderTopWidth: borderWidth.thin, borderTopColor: colors.borderLight },
    assetHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    assetValue: { ...textStyles.meta, fontSize: fontSize.xs, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    assetCopy: { flex: 1, minWidth: 0 },
    assetName: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
