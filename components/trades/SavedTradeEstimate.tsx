import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { MotionPressable } from '@/components/Motion'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { getSavedTradeEstimate, type TradeEstimateQuote } from '@/lib/trade-estimates'
import type { Trade } from '@/lib/trades'
import { colors, controlSize, fontSize, fontWeight, spacing } from '@/constants/tokens'

export function SavedTradeEstimate({ trade }: { trade: Trade }) {
    const [open, setOpen] = useState(false)
    const [quote, setQuote] = useState<TradeEstimateQuote | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [retry, setRetry] = useState(0)
    const quoteId = trade.estimate?.quoteId
    useEffect(() => {
        if (!open || !quoteId) return
        let active = true
        setQuote(null)
        setError(null)
        void getSavedTradeEstimate(quoteId).then(value => {
            if (active) setQuote(value)
        }).catch(cause => {
            if (active) setError(cause instanceof Error ? cause.message : 'Could not load this saved estimate.')
        })
        return () => { active = false }
    }, [open, quoteId, retry])
    const name = (memberId: string) => trade.participants.find(member => member.memberId === memberId)?.teamName ??
        (memberId === trade.proposerMemberId ? trade.proposerTeamName : trade.recipientTeamName)
    if (!trade.estimate) return <Text style={styles.detail}>{trade.estimateUnavailable ?? 'No estimate was saved with this trade.'}</Text>
    return (
        <View style={styles.root}>
            {trade.estimate.teams.map(team => <Text key={team.memberId} style={styles.detail}>
                {name(team.memberId)}: sent {team.valuesSent} · received {team.valuesReceived} · net {team.impact > 0 ? '+' : ''}{team.impact}
            </Text>)}
            <Text style={styles.detail}>Saved {new Date(trade.estimate.createdAt).toLocaleString()}</Text>
            <MotionPressable accessibilityRole="button" accessibilityState={{ expanded: open }}
                onPress={() => setOpen(value => !value)} style={styles.button} testID={`trade-saved-estimate-${trade.id}`}>
                <Text style={styles.link}>{open ? 'Hide saved estimate' : 'Saved estimate and sources'}</Text>
            </MotionPressable>
            {open && !quote && !error ? <Text style={styles.detail}>Loading saved estimate…</Text> : null}
            {open && error ? <MotionPressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={styles.button}>
                <Text style={styles.detail}>{error} Retry</Text>
            </MotionPressable> : null}
            {open && quote && quote.id === quoteId ? <TradeAnalysisSummary analysis={quote.analysis} participantName={name}
                inset={false} calculatedAt={quote.createdAt} saved /> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    root: { gap: spacing.xs },
    detail: { fontSize: fontSize.xs, color: colors.textSecondary },
    button: { minHeight: controlSize.minTouch, justifyContent: 'center' },
    link: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primaryDark },
})
