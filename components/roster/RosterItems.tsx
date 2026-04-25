import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useState } from 'react'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'
import { isIREligible, isTaxiEligible, RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { TradePickItem } from '@/lib/trades'
import { WaiverClaim } from '@/lib/waivers'
import { shortDateFmt, playerHeadshotUrl } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'

export function RosterClaimItem({
    claim,
    cancellingId,
    onCancel,
}: {
    claim: WaiverClaim
    cancellingId: string | null
    onCancel: (id: string) => void
}) {
    const isPending = claim.status === 'pending'
    const statusColor =
        claim.status === 'succeeded' ? colors.success
        : claim.status === 'pending' ? colors.info
        : colors.danger
    return (
        <View style={styles.claimRow}>
            <View style={styles.info}>
                <Text style={styles.playerName}>{claim.playerName}</Text>
                {claim.dropPlayerName ? (
                    <Text style={styles.playerMeta}>Drop: {claim.dropPlayerName}</Text>
                ) : null}
                <Text style={[styles.playerMeta, { color: statusColor }]}>
                    {claim.status === 'pending'
                        ? `Processes ${shortDateFmt.format(new Date(claim.processDate))}`
                        : claim.status === 'succeeded'
                          ? 'Succeeded'
                          : claim.status === 'failed_roster'
                            ? 'Failed: roster full'
                            : 'Failed: outbid'}
                </Text>
            </View>
            {isPending ? (
                <Pressable
                    style={styles.actionButton}
                    onPress={() => onCancel(claim.id)}
                    disabled={cancellingId === claim.id}
                >
                    {cancellingId === claim.id ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                        <Text style={styles.actionButtonText}>Cancel</Text>
                    )}
                </Pressable>
            ) : null}
        </View>
    )
}

export function RosterPickItem({
    pick,
    myTeamName,
}: {
    pick: TradePickItem
    myTeamName: string
}) {
    const isOwn = pick.originalTeamName === myTeamName
    return (
        <View style={styles.pickRow}>
            <View style={styles.pickCircle}>
                <Text style={styles.pickCircleText}>
                    {String(pick.seasonYear).slice(2)}
                </Text>
            </View>
            <View style={styles.info}>
                <Text style={styles.playerName}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                {!isOwn ? (
                    <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
                ) : null}
            </View>
        </View>
    )
}

export function RosterPlayerItem({
    item,
    togglingId,
    taxiingId,
    droppingId,
    taxiSlotsAvailable,
    onPress,
    onLongPress,
    onToggleIR,
    onToggleTaxi,
}: {
    item: RosterPlayer
    togglingId: string | null
    taxiingId: string | null
    droppingId: string | null
    taxiSlotsAvailable: boolean
    onPress: () => void
    onLongPress: () => void
    onToggleIR: (item: RosterPlayer) => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const positions = getEligiblePositions(player)
    const isBusy = togglingId === item.id || taxiingId === item.id || droppingId === item.id
    const [headshotError, setHeadshotError] = useState(false)
    const headshotUri = playerHeadshotUrl(player.nba_id)
    return (
        <Pressable style={styles.playerRow} onPress={onPress} onLongPress={onLongPress} delayLongPress={400}>
            <Avatar
                name={player.display_name}
                color={colors.bgMuted}
                uri={headshotUri && !headshotError ? headshotUri : undefined}
            />

            <View style={styles.info}>
                <Text style={styles.playerName}>{player.display_name}</Text>
                <View style={styles.playerMetaRow}>
                    {player.nba_team ? <Text style={styles.playerMeta}>{player.nba_team}</Text> : null}
                    {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
                {player.injury_status ? (
                    <View style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                        <Badge
                            label={player.injury_status}
                            color={INJURY_COLORS[player.injury_status] ?? colors.textMuted}
                            variant="solid"
                        />
                    </View>
                ) : null}
            </View>

            <View style={styles.rowActions}>
                {(item.is_on_ir || isIREligible(player.injury_status)) ? (
                    <Pressable
                        style={[styles.actionButton, item.is_on_ir && styles.irButtonActive]}
                        onPress={() => onToggleIR(item)}
                        disabled={isBusy}
                    >
                        {togglingId === item.id ? (
                            <ActivityIndicator size="small" color={item.is_on_ir ? colors.textWhite : colors.textMuted} />
                        ) : (
                            <Text style={[styles.actionButtonText, item.is_on_ir && styles.actionButtonTextActive]}>
                                {item.is_on_ir ? 'Active' : 'IR'}
                            </Text>
                        )}
                    </Pressable>
                ) : null}
                {!item.is_on_ir && taxiSlotsAvailable && isTaxiEligible(player) ? (
                    <Pressable
                        style={[styles.actionButton, styles.taxiButtonOutline]}
                        onPress={() => onToggleTaxi(item)}
                        disabled={isBusy}
                    >
                        {taxiingId === item.id ? (
                            <ActivityIndicator size="small" color={palette.indigo500} />
                        ) : (
                            <Text style={styles.taxiButtonOutlineText}>Taxi</Text>
                        )}
                    </Pressable>
                ) : null}
            </View>
        </Pressable>
    )
}

export function TaxiPlayerItem({
    item,
    taxiingId,
    onPress,
    onToggleTaxi,
}: {
    item: RosterPlayer
    taxiingId: string | null
    onPress: () => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const positions = getEligiblePositions(player)
    const [headshotError, setHeadshotError] = useState(false)
    const headshotUri = playerHeadshotUrl(player.nba_id)
    return (
        <Pressable style={styles.playerRow} onPress={onPress}>
            <Avatar
                name={player.display_name}
                color={colors.bgMuted}
                uri={headshotUri && !headshotError ? headshotUri : undefined}
            />

            <View style={styles.info}>
                <Text style={styles.playerName}>{player.display_name}</Text>
                <View style={styles.playerMetaRow}>
                    {player.nba_team ? <Text style={styles.playerMeta}>{player.nba_team}</Text> : null}
                    {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
            </View>

            <Pressable
                style={[styles.actionButton, styles.taxiButtonActive]}
                onPress={() => onToggleTaxi(item)}
                disabled={taxiingId === item.id}
            >
                {taxiingId === item.id ? (
                    <ActivityIndicator size="small" color={colors.textWhite} />
                ) : (
                    <Text style={[styles.actionButtonText, styles.actionButtonTextActive]}>Activate</Text>
                )}
            </Pressable>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },

    info: { flex: 1, gap: 2 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },

    rowActions: { flexDirection: 'row', gap: spacing.sm },

    actionButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        minWidth: 52,
        alignItems: 'center',
    },
    irButtonActive: { backgroundColor: colors.danger, borderColor: colors.danger },
    taxiButtonActive: { backgroundColor: palette.indigo500, borderColor: palette.indigo500 },
    taxiButtonOutline: { borderColor: palette.indigo500 },
    taxiButtonOutlineText: { fontSize: 12, fontWeight: fontWeight.bold, color: palette.indigo500 },
    actionButtonText: { fontSize: 12, fontWeight: fontWeight.bold, color: colors.textMuted },
    actionButtonTextActive: { color: colors.textWhite },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    pickCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.indigo500,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },

    claimRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
})
