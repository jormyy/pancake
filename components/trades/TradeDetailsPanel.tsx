import { formatLeagueDateTime } from '@/lib/timezone'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SavedTradeEstimate } from '@/components/trades/SavedTradeEstimate'
import { useLeagueContext } from '@/contexts/league-context'
import { PendingTradeRosterPlan } from './PendingTradeRosterPlan'
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
import { colors, fontSize, fontWeight, foundation, radii, spacing, textStyles } from '@/constants/tokens'

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
    const { currentLeague } = useLeagueContext()
    const { trade, myMemberId } = context
    const model = tradeCardModel({ ...context, timezone: currentLeague?.timezone })
    const [rosterValidity, setRosterValidity] = useState<{ trade: typeof trade; memberId: string; legal: boolean } | null>(null)
    const onValidityChange = useCallback((legal: boolean) => setRosterValidity({ trade, memberId: myMemberId, legal }), [trade, myMemberId])
    const acceptDisabled = Boolean(currentLeague && actions.onRosterPlan && (rosterValidity?.trade !== trade || rosterValidity.memberId !== myMemberId || !rosterValidity.legal))
    const proposed = `Proposed by ${trade.proposerMemberId === myMemberId ? 'you' : trade.proposerTeamName} · ${formatLeagueDateTime(trade.proposedAt, currentLeague?.timezone)}`

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

            {trade.completionFailureReason ? <Text>{trade.completionFailureReason}</Text> : null}
            <SavedTradeEstimate trade={trade} myMemberId={context.myMemberId} />
            {trade.status === 'pending' && currentLeague && actions.onRosterPlan ? <PendingTradeRosterPlan key={`${currentLeague.id}:${myMemberId}:${trade.id}`} trade={trade} memberId={myMemberId} onChange={actions.onRosterPlan} onValidityChange={onValidityChange} disabled={actions.acting} /> : null}
            <TradeActionButtons trade={trade} model={model} actions={{ ...actions, acceptDisabled }} />
            <MotionPressable
                style={styles.analyze}
                onPress={onAnalyze}
                disabled={actions.acting}
                accessibilityRole="button"
                accessibilityLabel="Revalue this trade with current inputs"
                accessibilityState={{ disabled: actions.acting }}
            >
                <Text style={styles.analyzeText}>Revalue with current inputs</Text>
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
        minHeight: foundation.minTouch,
        justifyContent: 'center',
    },
    analyzeText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
