import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, table, textStyles } from '@/constants/tokens'
import { LineupPlayer } from '@/lib/lineup'
import { isIREligible } from '@/lib/roster'


import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

type ActivationOverflowPending = { rosterPlayerId: string; source: 'ir' | 'taxi'; slotType?: string | null } | null

export function ActivationOverflowModal({
    pending,
    myLineup,
    saving,
    irSlots,
    allowIR = true,
    onDrop,
    onMoveToIR,
    onCancel,
}: {
    pending: ActivationOverflowPending
    myLineup: { starters: { player?: LineupPlayer | null }[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] } | null
    saving: boolean
    irSlots?: number
    allowIR?: boolean
    onDrop: (rosterPlayerId: string) => void
    onMoveToIR: (rosterPlayerId: string) => void
    onCancel: () => void
}) {
    const visible = pending !== null
    if (!visible || !myLineup) return null

    const activePlayers = [
        ...myLineup.starters.filter((s): s is { player: LineupPlayer } => !!s.player).map((s) => s.player),
        ...myLineup.bench,
    ]

    return (
        <Sheet visible onClose={onCancel} title="Active roster full">
            <Text style={styles.sub}>Drop a player or move an eligible player to IR to make room.</Text>
            <View style={styles.list}>
                {activePlayers.map((p) => (
                    <View key={p.rosterPlayerId} style={styles.row}>
                        <PlayerRowContent name={p.displayName} nbaId={p.nbaId} team={p.nbaTeam}
                            positions={p.eligiblePositions} playerId={p.playerId} yearsExp={p.yearsExp} careerGames={p.careerGames} injuryStatus={p.injuryStatus} />
                        <View style={styles.actions}>
                            {allowIR && (irSlots === undefined || myLineup.ir.length - (pending.source === 'ir' ? 1 : 0) < irSlots) && isIREligible(p.injuryStatus) ? (
                                <Button
                                    title="IR"
                                    size="sm"
                                    variant="outline"
                                    onPress={() => onMoveToIR(p.rosterPlayerId)}
                                    disabled={saving}
                                    accessibilityLabel={`Move ${p.displayName} to IR`}
                                />
                            ) : null}

                            <Button
                                title="Drop"
                                size="sm"
                                variant="outline"
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
        minHeight: table.rowHeight,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.md,
    },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    actions: { flexDirection: 'row', gap: spacing.xs },
    cancel: { marginTop: spacing.md },
})
