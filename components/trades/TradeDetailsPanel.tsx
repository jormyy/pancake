import { StyleSheet, Text, View } from 'react-native'
import { MotionPressable } from '@/components/Motion'
import { MultiTeamTradeOverview } from '@/components/trades/MultiTeamTradeOverview'
import {
    AssetList,
    StatusChip,
    TradeActionButtons,
    tradeCardModel,
    tradeFlowItem,
    type TradeCardActions,
    type TradeCardContext,
} from '@/components/trades/TradeCard'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'

const DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

/**
 * The whole trade: every asset with its season context, the multi-team routing,
 * the full note, and the same responses as the card. Shown beside the list on
 * wide screens and in a sheet on phones.
 */
export function TradeDetailsPanel({
    context,
    actions,
    onAnalyze,
    showHeader = true,
}: {
    context: TradeCardContext
    actions: TradeCardActions
    onAnalyze: () => void
    /** The sheet already titles the trade, so it hides this header. */
    showHeader?: boolean
}) {
    const { trade, myMemberId } = context
    const model = tradeCardModel(context)
    const proposed = `Proposed by ${trade.proposerMemberId === myMemberId ? 'you' : trade.proposerTeamName} · ${new Date(trade.proposedAt).toLocaleString([], DATE)}`

    return (
        <View style={styles.root}>
            {showHeader ? (
                <View style={styles.header}>
                    <Text style={styles.title} numberOfLines={2}>{model.opponentName}</Text>
                    <StatusChip model={model} />
                </View>
            ) : null}
            <Text style={styles.meta}>{[proposed, ...model.meta].join(' · ')}</Text>

            {trade.isMultiTeam ? (
                <MultiTeamTradeOverview
                    compact
                    participants={trade.participants.map((participant) => ({
                        memberId: participant.memberId,
                        label: participant.memberId === myMemberId ? 'You' : participant.teamName,
                        statusLabel: participant.acceptedAt ? 'Accepted' : 'Waiting',
                        statusComplete: participant.acceptedAt != null,
                    }))}
                    items={trade.routedItems.flatMap((item, index) => tradeFlowItem(item, index) ?? [])}
                />
            ) : (
                <View style={styles.sides}>
                    <AssetList items={model.receives} label={model.receiveLabel} />
                    <AssetList items={model.gives} label={model.giveLabel} />
                </View>
            )}

            {trade.notes ? (
                <View style={styles.note}>
                    <Text style={styles.noteLabel}>Note</Text>
                    <Text style={styles.noteText}>{trade.notes}</Text>
                </View>
            ) : null}

            <TradeActionButtons trade={trade} model={model} actions={actions} />
            <MotionPressable
                style={styles.analyze}
                onPress={onAnalyze}
                disabled={actions.acting}
                accessibilityRole="button"
                accessibilityLabel={`Analyze this trade in the analyzer`}
                accessibilityState={{ disabled: actions.acting }}
                pressedScale={0.96}
            >
                <Text style={styles.analyzeText}>Open in Analyzer</Text>
            </MotionPressable>
        </View>
    )
}

const styles = StyleSheet.create({
    root: { gap: spacing.lg },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    title: { ...textStyles.pageTitle, flex: 1, minWidth: 0 },
    meta: { ...textStyles.meta },
    sides: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xl },
    note: {
        gap: spacing.xs,
        padding: spacing.lg,
        borderRadius: radii.lg,
        backgroundColor: colors.bgSubtle,
    },
    noteLabel: { ...textStyles.sectionLabel },
    noteText: { ...textStyles.body },
    analyze: {
        alignSelf: 'flex-start',
        minHeight: 44,
        justifyContent: 'center',
    },
    analyzeText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
