import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { LineupPlayer } from '@/lib/lineup'
import { isIREligible } from '@/lib/roster'
import { playerHeadshotUrl } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

export type ActivationOverflowPending = { rosterPlayerId: string; source: 'ir' | 'taxi'; slotType?: string | null } | null

export function ActivationOverflowModal({
    pending,
    myLineup,
    leagueTaxiSlots,
    saving,
    onDrop,
    onMoveToIR,
    onMoveToTaxi,
    onCancel,
}: {
    pending: ActivationOverflowPending
    myLineup: { starters: { player?: LineupPlayer | null }[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] } | null
    leagueTaxiSlots: number
    saving: boolean
    onDrop: (rosterPlayerId: string) => void
    onMoveToIR: (rosterPlayerId: string) => void
    onMoveToTaxi: (rosterPlayerId: string) => void
    onCancel: () => void
}) {
    const visible = pending !== null
    if (!visible || !myLineup) return null

    const activePlayers = [
        ...myLineup.starters.filter((s): s is { player: LineupPlayer } => !!s.player).map((s) => s.player),
        ...myLineup.bench,
    ]

    const taxiAvailable = leagueTaxiSlots > myLineup.taxi.length

    return (
        <Sheet visible onClose={onCancel} title="Active roster full">
            <Text style={styles.sub}>Drop a player, or move one to IR or the taxi squad, to make room.</Text>
            <View style={styles.list}>
                {activePlayers.map((p) => (
                    <View key={p.rosterPlayerId} style={styles.row}>
                        <Avatar
                            name={p.displayName}
                            uri={playerHeadshotUrl(p.nbaId) ?? undefined}
                            color={colors.bgMuted}
                            size={36}
                        />
                        <View style={styles.info}>
                            <Text style={textStyles.rowTitle} numberOfLines={1}>{p.displayName}</Text>
                            <Text style={textStyles.meta}>
                                {p.nbaTeam ?? 'FA'}
                                {p.position ? ` · ${p.position}` : ''}
                            </Text>
                        </View>
                        <View style={styles.actions}>
                            {isIREligible(p.injuryStatus) ? (
                                <Button
                                    title="IR"
                                    size="sm"
                                    variant="secondary"
                                    onPress={() => onMoveToIR(p.rosterPlayerId)}
                                    disabled={saving}
                                    accessibilityLabel={`Move ${p.displayName} to IR`}
                                />
                            ) : null}
                            {taxiAvailable ? (
                                <Button
                                    title="Taxi"
                                    size="sm"
                                    variant="secondary"
                                    onPress={() => onMoveToTaxi(p.rosterPlayerId)}
                                    disabled={saving}
                                    accessibilityLabel={`Move ${p.displayName} to taxi squad`}
                                />
                            ) : null}
                            <Button
                                title="Drop"
                                size="sm"
                                variant="danger"
                                onPress={() => onDrop(p.rosterPlayerId)}
                                disabled={saving}
                                accessibilityLabel={`Drop ${p.displayName}`}
                            />
                        </View>
                    </View>
                ))}
            </View>
            <Button title="Cancel" variant="ghost" onPress={onCancel} fullWidth style={styles.cancel} />
        </Sheet>
    )
}

const styles = StyleSheet.create({
    sub: { ...textStyles.body, marginBottom: spacing.md },
    list: { borderTopWidth: 1, borderTopColor: colors.separator },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 56,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.md,
    },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    actions: { flexDirection: 'row', gap: spacing.xs },
    cancel: { marginTop: spacing.md },
})
