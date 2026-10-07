import { StyleSheet, Text, View } from 'react-native'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'

export function TradeAnalysisSummary({
    analysis,
    participantName,
    loading = false,
    cached = false,
    inset = true,
}: {
    analysis: DynastyTradeAnalysis | null
    participantName: (memberId: string) => string
    loading?: boolean
    cached?: boolean
    /** Outer margin for full-width placement; a side column sets this false. */
    inset?: boolean
}) {
    if (!analysis) {
        return (
            <View style={[styles.empty, inset && styles.inset]} accessibilityLiveRegion="polite">
                <Text style={styles.emptyTitle}>{loading ? 'Calculating league values…' : 'Add assets to see the 5-year outlook.'}</Text>
            </View>
        )
    }

    return (
        <View style={[styles.root, inset && styles.inset]} accessibilityLabel="Dynasty trade analysis">
            <View style={styles.headingRow}>
                <Text style={styles.title}>5-year outlook</Text>
                <Text style={styles.confidence}>{Math.round(analysis.confidence * 100)}% confidence{cached ? ' · cached' : ''}</Text>
            </View>
            <View style={styles.teamGrid}>
                {analysis.teams.map((team) => (
                    <View key={team.memberId} style={styles.teamCard}>
                        <Text style={styles.teamName}>{participantName(team.memberId)}</Text>
                        <Text style={styles.value}>Net value {signed(team.impact)}</Text>
                        <Text style={styles.detail}>Current points {signed(team.shortTermPoints)}</Text>
                        <Text style={styles.detail}>Long-term value {signed(team.longTermValue)}</Text>
                        <Text style={styles.detail}>Sent {team.valuesSent} · Received {team.valuesReceived}</Text>
                        <Text style={styles.detail}>Roster slots {signed(team.rosterSlotEffect)} · Replacement {signed(team.replacementEffect)}</Text>
                        <Text style={styles.detail}>Package effect {signed(team.packageEffect)}</Text>
                    </View>
                ))}
            </View>
            <Text style={styles.subhead}>Asset details</Text>
            {analysis.assets.map((asset) => (
                <View key={`${asset.kind}:${asset.assetId}`} style={styles.assetRow}>
                    <View style={styles.assetCopy}>
                        <Text style={styles.assetName}>{asset.label}</Text>
                        <Text style={styles.detail}>Value {asset.values[analysis.strategy]} · Current {asset.components.shortTermPoints} · Long-term {asset.components.longTermValue}</Text>
                        {asset.ranges[analysis.strategy] ? (
                            <Text style={styles.detail}>Range {asset.ranges[analysis.strategy]?.low}–{asset.ranges[analysis.strategy]?.high}</Text>
                        ) : null}
                    </View>
                    <Text style={styles.confidence}>{Math.round(asset.confidence * 100)}%</Text>
                </View>
            ))}
            <Text style={styles.subhead}>Sources and limits</Text>
            <Text style={styles.detail}>{analysis.sources.length > 0
                ? analysis.sources.map((source) => `${source.name} · ${source.fetchedAt ? new Date(source.fetchedAt).toLocaleDateString() : 'Not dated'}`).join('\n')
                : 'No dated source was available.'}</Text>
            <Text style={styles.detail}>Missing: {analysis.missingInputs.length > 0 ? analysis.missingInputs.join(', ') : 'None'}</Text>
        </View>
    )
}

function signed(value: number): string {
    if (value > 0) return `+${value}`
    return String(value)
}

const styles = StyleSheet.create({
    inset: { margin: spacing.xl },
    root: { padding: spacing.xl, gap: spacing.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.xl },
    headingRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm },
    title: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary },
    confidence: { ...textStyles.meta, fontWeight: fontWeight.semibold },
    teamGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    teamCard: { flexGrow: 1, flexBasis: 210, minWidth: 0, padding: spacing.lg, gap: spacing.xxs, backgroundColor: colors.bgMuted, borderRadius: radii.lg },
    teamName: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    value: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primaryDark },
    detail: { fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 18 },
    subhead: { ...textStyles.sectionLabel, marginTop: spacing.xs },
    assetRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderLight },
    assetCopy: { flex: 1, minWidth: 0 },
    assetName: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
    empty: { padding: spacing.xl, gap: spacing.xs, backgroundColor: colors.bgSubtle, borderRadius: radii.lg },
    emptyTitle: { ...textStyles.body, fontWeight: fontWeight.semibold },
})
