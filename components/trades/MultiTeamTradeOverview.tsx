import { orderTradeAssets, type TradePickOrder } from '@/lib/trade-assets'
import { TradePlayerLink, type TradePlayerLinkProps } from '@/components/trades/TradePlayerLink'
import { TradePickLabel } from '@/components/trades/TradePickLabel'
import { SectionBand } from '@/components/ui/SectionBand'
import { tradePickLabel, type TradePickContext } from '@/lib/trade-pick-label'
import type { TradePickItem } from '@/lib/trades'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { borderWidth, colors, controlSize, fontWeight, radii, spacing, uiColors, typeScale } from '@/constants/tokens'

type TradeFlowParticipant = {
    memberId: string
    label: string
    statusLabel?: string | null
    statusComplete?: boolean
}

export type TradeFlowItem = {
    key: string
    fromMemberId: string
    toMemberId: string
    label: string
    tradeValue?: number | null
    playerId?: string
    detail?: string | null
    player?: TradePlayerLinkProps
    pick?: TradePickItem
}

type MultiTeamTradeOverviewProps = {
    participants: TradeFlowParticipant[]
    items: TradeFlowItem[]
    compact?: boolean
    columns?: boolean
    /** False when the parent already draws the card, as on the trade details panel. */
    framed?: boolean
    onRemoveItem?: (key: string) => void
    pickContext?: TradePickContext
    showPickDirection?: boolean
    pickOrder?: TradePickOrder
    style?: StyleProp<ViewStyle>
}

export function MultiTeamTradeOverview({ participants, items, compact = false, columns = false, framed = true, onRemoveItem, pickContext, showPickDirection = true, pickOrder = 'round-year', style }: MultiTeamTradeOverviewProps) {
    const { incomingByMember, participantLabels } = useMemo(() => {
        const labels = new Map(participants.map((participant) => [participant.memberId, participant.label]))
        const incoming = new Map<string, TradeFlowItem[]>()
        for (const item of orderTradeAssets(items, item => item.pick ?? { kind: item.player ? 'player' : 'faab', tradeValue: item.tradeValue, playerName: item.label, playerId: item.playerId }, pickOrder)) {
            const bucket = incoming.get(item.toMemberId)
            if (bucket) bucket.push(item)
            else incoming.set(item.toMemberId, [item])
        }
        return { incomingByMember: incoming, participantLabels: labels }
    }, [items, participants, pickOrder])

    return (
        <View style={[styles.root, columns && styles.rootColumns, style]}>
            {participants.map((participant) => {
                const incoming = incomingByMember.get(participant.memberId) ?? []
                const label = participant.label === 'You' ? 'You get' : `${participant.label} gets`

                return (
                    <View
                        key={participant.memberId}
                        style={[styles.section, framed && styles.sectionFramed, columns && styles.sectionColumn]}
                    >
                        <SectionBand
                            label={label}
                            detail={participant.statusLabel ? (
                                <View style={[styles.status, participant.statusComplete && styles.statusComplete]}>
                                    <MaterialIcons
                                        name={participant.statusComplete ? 'check-circle' : 'schedule'}
                                        size={14}
                                        color={participant.statusComplete ? uiColors.successText : colors.textMuted}
                                    />
                                    <Text style={[styles.statusText, participant.statusComplete && styles.statusTextComplete]} numberOfLines={1}>
                                        {participant.statusLabel}
                                    </Text>
                                </View>
                            ) : undefined}
                        />
                        {incoming.length === 0 ? (
                            <Text style={styles.empty}>Nothing yet</Text>
                        ) : incoming.map((item, index) => (
                            <View key={item.key} style={[styles.assetRow, compact && styles.assetRowCompact, index > 0 && styles.assetDivider]}>
                                {item.player ? <TradePlayerLink {...item.player} stats={[typeof item.player.stats === 'string' ? item.player.stats : null, `From ${participantLabels.get(item.fromMemberId) ?? 'Unknown team'}`, item.detail].filter(Boolean).join(' · ')} /> : (
                                    <View style={styles.assetCopy}>
                                        {item.pick ? <TradePickLabel pick={item.pick} context={pickContext} showDirection={showPickDirection} /> : <Text style={styles.assetLabel} numberOfLines={1}>{item.label}</Text>}
                                        <Text style={styles.assetSource} numberOfLines={1}>
                                            From {participantLabels.get(item.fromMemberId) ?? 'Unknown team'}
                                            {item.detail ? ` · ${item.detail}` : ''}
                                        </Text>
                                    </View>
                                )}
                                {onRemoveItem ? (
                                    <Pressable style={styles.removeAsset}
                                        onPress={() => onRemoveItem(item.key)} accessibilityRole="button"
                                        accessibilityState={{ selected: true }}
                                        accessibilityLabel={`Remove ${item.pick ? tradePickLabel(item.pick, pickContext, showPickDirection) : item.label} sent by ${participantLabels.get(item.fromMemberId) ?? 'Unknown team'} from trade`}>
                                        <Text style={styles.removeAssetText} numberOfLines={1}>Remove</Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        ))}
                    </View>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    root: { gap: spacing.md, minWidth: 0 },
    rootColumns: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
    section: { minWidth: 0, overflow: 'hidden' },
    sectionFramed: {
        borderWidth: borderWidth.thin,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
    },
    sectionColumn: { flexGrow: 1, flexBasis: 280, alignSelf: 'stretch' },
    empty: {
        ...typeScale.small,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        color: colors.textMuted,
    },
    assetRow: {
        minHeight: controlSize.minTouch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    assetRowCompact: { paddingVertical: spacing.xs },
    assetDivider: { borderTopWidth: borderWidth.thin, borderTopColor: colors.separator },
    assetCopy: { minWidth: 0, flex: 1 },
    assetLabel: {
        ...typeScale.small,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    assetSource: {
        ...typeScale.caption,
        marginTop: spacing.xxs,
        color: colors.textMuted,
    },
    removeAsset: {
        minWidth: controlSize.minTouch,
        minHeight: controlSize.minTouch,
        flexShrink: 0,
        paddingHorizontal: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: borderWidth.thin,
        borderColor: colors.primaryBorder,
    },
    removeAssetText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        minHeight: 28,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
    },
    statusComplete: { backgroundColor: uiColors.successSurface },
    statusText: {
        ...typeScale.caption,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    statusTextComplete: { color: uiColors.successText },
})
