import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { StyleSheet, Text, View } from 'react-native'
import type { RosterPlayer } from '@/lib/roster'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { formatTradeValue } from '@/lib/trade-estimates'
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
    if (!analysis) return null

    return (
        <DeferredContent ready={!loading} style={{ flex: 0, minHeight: componentTokens.tradeAnalyzer.pendingHeight }}>
        <View style={[styles.root, inset && styles.inset]} accessibilityLabel="Dynasty trade analysis" aria-busy={loading}>
            <View style={styles.teamGrid}>
                {analysis.teams.map((team) => (
                    <View key={team.memberId} style={styles.teamCard}>
                        <Text style={styles.teamName}>{participantName(team.memberId)}</Text>
                        <Text style={styles.detail}>{formatTradeValue(team.valuesSent)} vs {formatTradeValue(team.valuesReceived)}</Text>
                        <Text style={[styles.value, team.impact < 0 && styles.valueNegative]}>{signed(team.impact)}</Text>
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
        </DeferredContent>
    )
}

function assetValueLine(asset: DynastyTradeAnalysis['assets'][number], strategy: DynastyTradeAnalysis['strategy']): string {
    const range = asset.ranges[strategy]
    return `Value ${formatTradeValue(asset.values[strategy])} · Now ${asset.components.shortTermPoints} · Long ${formatTradeValue(asset.components.longTermValue)}${range ? ` · ${formatTradeValue(range.low)}–${formatTradeValue(range.high)}` : ''}`
}

function signed(value: number): string {
    if (value > 0) return `+${value}`
    return String(value)
}

const styles = StyleSheet.create({
    inset: { margin: spacing.xl },
    root: { gap: spacing.md },
    teamGrid: { gap: spacing.xs },
    teamCard: { flexDirection: 'row', alignItems: 'center', minHeight: componentTokens.playerRow.compact.minHeight, paddingHorizontal: componentTokens.playerRow.compact.paddingHorizontal, gap: spacing.md, width: '100%' },
    teamName: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    value: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primaryDark },
    valueNegative: { color: colors.dangerDark },
    detail: { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: lineHeight.body },
    assetRow: { gap: spacing.xxs, paddingVertical: spacing.sm, borderTopWidth: borderWidth.thin, borderTopColor: colors.borderLight },
    assetHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    assetValue: { ...textStyles.meta, fontSize: fontSize.xs, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
    assetCopy: { flex: 1, minWidth: 0 },
    assetName: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
