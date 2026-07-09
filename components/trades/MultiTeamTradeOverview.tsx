import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { breakpoints, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'

export type TradeFlowParticipant = {
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
    detail?: string | null
}

type MultiTeamTradeOverviewProps = {
    participants: TradeFlowParticipant[]
    items: TradeFlowItem[]
}

export function MultiTeamTradeOverview({ participants, items }: MultiTeamTradeOverviewProps) {
    const { width } = useWindowDimensions()
    const useColumns = width >= breakpoints.roster
    const participantLabels = new Map(participants.map((participant) => [participant.memberId, participant.label]))

    return (
        <View style={styles.container}>
            <View style={styles.headingRow}>
                <Text style={styles.heading}>DEAL OVERVIEW</Text>
                <Text style={styles.teamCount}>{participants.length} teams</Text>
            </View>
            <View style={styles.teamGrid}>
                {participants.map((participant) => {
                    const incoming = items.filter((item) => item.toMemberId === participant.memberId)
                    const outgoingCount = items.filter((item) => item.fromMemberId === participant.memberId).length

                    return (
                        <View
                            key={participant.memberId}
                            style={[styles.team, useColumns && styles.teamColumn]}
                        >
                            <View style={styles.teamHeader}>
                                <View style={styles.teamIdentity}>
                                    <View style={styles.teamInitial}>
                                        <Text style={styles.teamInitialText}>
                                            {participant.label.trim().charAt(0).toUpperCase() || '?'}
                                        </Text>
                                    </View>
                                    <View style={styles.teamTitleBlock}>
                                        <Text style={styles.teamName} numberOfLines={1}>{participant.label}</Text>
                                        <Text style={styles.receivesLabel}>RECEIVES</Text>
                                    </View>
                                </View>
                                {participant.statusLabel ? (
                                    <View style={[styles.status, participant.statusComplete && styles.statusComplete]}>
                                        <MaterialIcons
                                            name={participant.statusComplete ? 'check-circle' : 'schedule'}
                                            size={14}
                                            color={participant.statusComplete ? uiColors.successText : colors.textMuted}
                                        />
                                        <Text style={[styles.statusText, participant.statusComplete && styles.statusTextComplete]}>
                                            {participant.statusLabel}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>

                            <View style={styles.assets}>
                                {incoming.length === 0 ? (
                                    <Text style={styles.empty}>No incoming assets</Text>
                                ) : incoming.map((item) => (
                                    <View key={item.key} style={styles.assetRow}>
                                        <MaterialIcons name="arrow-forward" size={16} color={colors.primary} />
                                        <View style={styles.assetCopy}>
                                            <Text style={styles.assetLabel} numberOfLines={2}>{item.label}</Text>
                                            <Text style={styles.assetSource} numberOfLines={1}>
                                                From {participantLabels.get(item.fromMemberId) ?? 'Unknown team'}
                                                {item.detail ? ` · ${item.detail}` : ''}
                                            </Text>
                                        </View>
                                    </View>
                                ))}
                            </View>

                            <Text style={styles.sendsLabel}>
                                SENDS {outgoingCount} {outgoingCount === 1 ? 'ASSET' : 'ASSETS'}
                            </Text>
                        </View>
                    )
                })}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xl,
        gap: spacing.md,
    },
    headingRow: {
        minHeight: 24,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    heading: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
    },
    teamCount: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    teamGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    team: {
        width: '100%',
        minWidth: 0,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        padding: spacing.md,
        gap: spacing.sm,
    },
    teamColumn: {
        flexGrow: 1,
        flexBasis: 280,
        width: 'auto',
    },
    teamHeader: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    teamIdentity: {
        minWidth: 0,
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    teamInitial: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    teamInitialText: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    teamTitleBlock: { minWidth: 0, flex: 1 },
    teamName: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    receivesLabel: {
        marginTop: 2,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minHeight: 28,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
    },
    statusComplete: { backgroundColor: uiColors.successSurface },
    statusText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    statusTextComplete: { color: uiColors.successText },
    assets: { gap: spacing.xs },
    assetRow: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
        paddingVertical: 3,
    },
    assetCopy: { minWidth: 0, flex: 1 },
    assetLabel: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    assetSource: {
        marginTop: 2,
        fontSize: fontSize.xs,
        color: colors.textMuted,
    },
    empty: {
        paddingVertical: spacing.sm,
        fontSize: fontSize.sm,
        color: colors.textMuted,
    },
    sendsLabel: {
        paddingTop: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
})
