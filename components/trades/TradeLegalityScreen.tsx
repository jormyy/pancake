import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ComponentProps } from 'react'
import { ErrorBanner, PageHeader } from '@/components/ui'
import { colors, controlSize, radii, spacing, textStyles } from '@/constants/tokens'
import { isTradeRosterLegal } from '@/lib/trade-legality-step'
import { tradeRosterReasons } from '@/lib/trade-roster-status'
import type { Trade, TradeRosterPreview } from '@/lib/trades'
import { TradeCard } from './TradeCard'
import { TradeRosterPlanEditor } from './TradeRosterPlanEditor'

export function TradeLegalityScreen({ trade, memberId, teams, loading, saving, error, onRetry, onClose, onSubmit, mode, editor, retrying = false }: {
    trade: Trade
    memberId: string
    teams: TradeRosterPreview[]
    loading: boolean
    saving: boolean
    error: string | null
    onRetry: () => void
    onClose: () => void
    onSubmit: () => void
    retrying?: boolean
    mode: 'propose' | 'accept'
    editor: ComponentProps<typeof TradeRosterPlanEditor>
}) {
    const own = teams.find(team => team.memberId === memberId)
    const legal = isTradeRosterLegal(own)
    const ready = !loading && !saving && (retrying || !error && legal)
    const action = mode === 'propose' ? 'Send' : 'Accept'
    return <View style={styles.root} testID="trade-legality-screen">
        <PageHeader title="Review trade" onBack={onClose} backLabel="Close trade review"
            actions={<Pressable onPress={onSubmit} disabled={!ready} style={[styles.submit, !ready && styles.disabled]}
                accessibilityRole="button" accessibilityLabel={action} accessibilityState={{ disabled: !ready, busy: saving }}
                testID={mode === 'propose' ? 'trade-confirm-submit' : 'trade-confirm-accept'}>
                <Text style={[textStyles.rowTitle, { color: ready ? colors.textWhite : colors.textDisabled }]}>{action}</Text>
            </Pressable>} />
        <ScrollView contentContainerStyle={styles.content}>
            <TradeCard trade={trade} myMemberId={memberId} tab="offers" acting={saving} reviewMode={mode}
                onAccept={onSubmit} onReject={onClose} onVeto={onClose} onWithdraw={onClose} onAnalyze={onClose} />
            <View style={styles.status} accessibilityLiveRegion="polite" testID="trade-roster-status">
                <Text style={[textStyles.rowTitle, { color: loading ? colors.textSecondary : legal ? colors.successDark : colors.dangerDark }]}>
                    {loading ? 'Checking roster…' : legal ? 'Valid roster' : 'Invalid roster'}
                </Text>
                {!loading && !legal && own ? tradeRosterReasons(own).map(reason => <Text key={reason} numberOfLines={1} style={textStyles.meta}>• {reason}</Text>) : null}
            </View>
            {error ? <ErrorBanner message={error} onRetry={onRetry} /> : null}
            <TradeRosterPlanEditor {...editor} preview={own} disabled={saving || !own} />
        </ScrollView>
    </View>
}

const styles = StyleSheet.create({
    submit: { minHeight: controlSize.minTouch, minWidth: 72, paddingHorizontal: spacing.lg, borderRadius: radii.md, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
    disabled: { backgroundColor: colors.bgMuted },
    root: { flex: 1, minHeight: 0, backgroundColor: colors.bgScreen },
    content: { width: '100%', maxWidth: 900, alignSelf: 'center', padding: spacing.lg, gap: spacing.lg },
    status: { padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.bgCard, borderRadius: radii.lg },
})
