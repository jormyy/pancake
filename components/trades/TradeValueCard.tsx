import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { DynastyTradeAnalysis } from '@/core/src/dynasty/decisionEngine'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { tradeComparison } from '@/lib/trade-estimates'
import { colors, controlSize, fontWeight, radii, spacing, textStyles, typeScale, componentTokens } from '@/constants/tokens'

type TeamValue = { memberId: string; total: number; net: number }

function tradeVerdict(analysis: DynastyTradeAnalysis, myMemberId: string, participantName: (memberId: string) => string) {
    const comparison = tradeComparison(analysis.teams)
    const winner = comparison.totals.find((team) => team.memberId === comparison.winnerMemberId)
    if (!winner) return 'Even trade'
    const margin = Math.round(Math.abs(winner.net))
    if (margin === 0) return 'Even trade'
    return winner.memberId === myMemberId ? `You win by ${margin}` : `${participantName(winner.memberId)} wins by ${margin}`
}

export function TradeValueCard({
    analysis,
    loading,
    updating = false,
    error,
    empty,
    myMemberId,
    participantIds,
    participantName,
    detailsOpen = false,
    onToggleDetails,
    onRetry,
}: {
    analysis: DynastyTradeAnalysis | null
    loading: boolean
    updating?: boolean
    error?: string | null
    empty: boolean
    myMemberId: string
    participantIds: string[]
    participantName: (memberId: string) => string
    detailsOpen?: boolean
    onToggleDetails?: () => void
    onRetry?: () => void
}) {
    const shown = !empty && !loading && analysis && analysis.teams.length > 0 ? analysis : null
    const name = (memberId: string) => memberId === myMemberId ? 'You' : participantName(memberId)
    const teams: TeamValue[] = shown ? tradeComparison(shown.teams).totals : []
    const ordered = [
        ...participantIds.flatMap((memberId) => teams.filter((team) => team.memberId === memberId)),
        ...teams.filter((team) => !participantIds.includes(team.memberId)),
    ]
    const detailsButton = shown && onToggleDetails ? (
        <Pressable
            style={styles.detailsButton}
            onPress={onToggleDetails}
            accessibilityRole="button"
            accessibilityLabel={detailsOpen ? 'Hide trade value details' : 'Show trade value details'}
            accessibilityState={{ expanded: detailsOpen }}
            testID="trade-value-details"
            id="trade-value-details"
        >
            <Text style={styles.detailsText} numberOfLines={1}>Details</Text>
            <MaterialIcons name={detailsOpen ? 'expand-less' : 'expand-more'} size={controlSize.icon.sm} color={colors.primaryDark} />
        </Pressable>
    ) : null

    return (
        <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label="Trade value" detail={detailsButton} style={detailsButton ? styles.bandWithAction : undefined} />
            <View style={styles.body} accessibilityLiveRegion="polite" testID="trade-value">
                {shown ? (
                    <>
                        <Text style={styles.verdict} numberOfLines={1}>{updating ? 'Updating values…' : tradeVerdict(shown, myMemberId, participantName)}</Text>
                        {ordered.length === 2 ? (
                            <TwoTeamBar left={ordered[0]} right={ordered[1]} leftName={name(ordered[0].memberId)} rightName={name(ordered[1].memberId)} />
                        ) : (
                            <View style={styles.teamList}>
                                {ordered.map((team) => <TeamNetRow key={team.memberId} team={team} label={name(team.memberId)}
                                    scale={Math.max(1, ...ordered.map((entry) => Math.abs(entry.net)))} />)}
                            </View>
                        )}
                    </>
                ) : error && !empty ? (
                    <Pressable style={styles.placeholderRow} onPress={onRetry} disabled={!onRetry} accessibilityRole="button"
                        accessibilityLabel="Could not value this trade. Tap to retry.">
                        <Text style={styles.placeholder} numberOfLines={2}>Could not value this trade. Tap to retry.</Text>
                    </Pressable>
                ) : (
                    <View style={styles.placeholderRow}>
                        <Text style={styles.placeholder} numberOfLines={1}>
                            {empty ? 'Add players or picks to see the value.' : 'Updating values…'}
                        </Text>
                        <View style={styles.bar}><View style={styles.barEmpty} /></View>
                    </View>
                )}
            </View>
        </Card>
    )
}

function TwoTeamBar({ left, right, leftName, rightName }: { left: TeamValue; right: TeamValue; leftName: string; rightName: string }) {
    const leftValue = Math.max(0, left.total)
    const rightValue = Math.max(0, right.total)
    const even = leftValue + rightValue === 0
    return (
        <View style={styles.twoTeam} accessibilityLabel={`${leftName} get ${Math.round(left.total)}. ${rightName} get ${Math.round(right.total)}.`}>
            <View style={styles.bar}>
                <View style={[styles.barLeft, { flex: even ? 1 : leftValue }]} />
                <View style={[styles.barRight, { flex: even ? 1 : rightValue }]} />
            </View>
            <View style={styles.sides}>
                <Text style={[styles.sideName, styles.sideLeft]} numberOfLines={1}>{leftName} {Math.round(left.total)}</Text>
                <Text style={[styles.sideName, styles.sideRight]} numberOfLines={1}>{rightName} {Math.round(right.total)}</Text>
            </View>
        </View>
    )
}

function TeamNetRow({ team, label, scale }: { team: TeamValue; label: string; scale: number }) {
    const net = Math.round(team.net)
    const share = Math.abs(team.net) / scale
    return (
        <View style={styles.teamRow}>
            <View style={styles.teamLine}>
                <Text style={styles.teamName} numberOfLines={1}>{label}</Text>
                <Text style={[styles.teamNet, net < 0 && styles.negative]} numberOfLines={1}>{net > 0 ? `+${net}` : `${net}`}</Text>
            </View>
            <View style={styles.bar}>
                <View style={[net < 0 ? styles.barNegative : styles.barLeft, { flex: share }]} />
                <View style={{ flex: 1 - share }} />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: { overflow: 'hidden' },
    bandWithAction: { paddingVertical: spacing.none },
    body: { padding: componentTokens.sectionBand.paddingHorizontal, gap: spacing.sm },
    detailsButton: {
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xxs,
        minHeight: controlSize.minTouch,
        minWidth: controlSize.minTouch,
        paddingHorizontal: spacing.xs,
        justifyContent: 'center',
    },
    detailsText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    verdict: { ...textStyles.rowTitle },
    placeholderRow: { gap: spacing.sm, minHeight: controlSize.minTouch, justifyContent: 'center' },
    placeholder: { ...textStyles.meta, color: colors.textPlaceholder },
    twoTeam: { gap: spacing.xs },
    bar: {
        flexDirection: 'row',
        height: spacing.sm,
        borderRadius: radii.full,
        overflow: 'hidden',
        backgroundColor: colors.bgMuted,
    },
    barEmpty: { flex: 1 },
    barLeft: { backgroundColor: colors.primary },
    barRight: { backgroundColor: colors.info },
    barNegative: { backgroundColor: colors.danger },
    sides: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, minWidth: 0 },
    sideName: { ...textStyles.meta, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.semibold, fontVariant: ['tabular-nums'] },
    sideLeft: { color: colors.primaryDark },
    sideRight: { color: colors.info, textAlign: 'right' },
    teamList: { gap: spacing.sm },
    teamRow: { gap: spacing.xxs },
    teamLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md, minWidth: 0 },
    teamName: { ...textStyles.meta, flex: 1, minWidth: 0, color: colors.textPrimary, fontWeight: fontWeight.semibold },
    teamNet: { ...textStyles.meta, flexShrink: 0, color: colors.successDark, fontWeight: fontWeight.bold, fontVariant: ['tabular-nums'] },
    negative: { color: colors.dangerDark },
})
