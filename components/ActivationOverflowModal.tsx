import { View, Text, Pressable, StyleSheet, Modal, ScrollView } from 'react-native'
import { alpha, colors, palette, fontSize, fontWeight, scrim } from '@/constants/tokens'
import { LineupPlayer } from '@/lib/lineup'
import { isIREligible } from '@/lib/roster'

export type ActivationOverflowPending = { rosterPlayerId: string; source: 'ir' | 'taxi' } | null

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
        <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
            <View style={styles.modalOverlay}>
                <View style={styles.modalSheet}>
                    <Text style={styles.modalTitle}>Active Roster Full</Text>
                    <Text style={styles.modalSub}>
                        Drop a player, move one to IR, or move one to Taxi Squad to make room.
                    </Text>
                    <ScrollView style={{ maxHeight: 360 }}>
                        {activePlayers.map((p) => (
                            <View key={p.rosterPlayerId} style={styles.overflowRow}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.overflowName} numberOfLines={1}>
                                        {p.displayName}
                                    </Text>
                                    <Text style={styles.overflowMeta}>
                                        {p.nbaTeam ?? 'FA'}
                                        {p.position ? ` · ${p.position}` : ''}
                                    </Text>
                                </View>
                                {isIREligible(p.injuryStatus) && (
                                    <Pressable
                                        style={[styles.overflowBtn, { backgroundColor: alpha(palette.red900, 0.13), marginRight: 6 }]}
                                        onPress={() => onMoveToIR(p.rosterPlayerId)}
                                        disabled={saving}
                                    >
                                        <Text style={[styles.overflowBtnText, { color: palette.red900 }]}>→ IR</Text>
                                    </Pressable>
                                )}
                                {taxiAvailable && (
                                    <Pressable
                                        style={[styles.overflowBtn, { backgroundColor: alpha(palette.latte, 0.13), marginRight: 6 }]}
                                        onPress={() => onMoveToTaxi(p.rosterPlayerId)}
                                        disabled={saving}
                                    >
                                        <Text style={[styles.overflowBtnText, { color: palette.latte }]}>→ TX</Text>
                                    </Pressable>
                                )}
                                <Pressable
                                    style={[styles.overflowBtn, { backgroundColor: alpha(palette.red500, 0.13) }]}
                                    onPress={() => onDrop(p.rosterPlayerId)}
                                    disabled={saving}
                                >
                                    <Text style={[styles.overflowBtnText, { color: colors.danger }]}>Drop</Text>
                                </Pressable>
                            </View>
                        ))}
                    </ScrollView>
                    <Pressable style={styles.modalCancel} onPress={onCancel}>
                        <Text style={styles.modalCancelText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    modalOverlay: { flex: 1, backgroundColor: scrim, justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: colors.bgScreen, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 12 },
    modalTitle: { fontSize: 17, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    modalSub: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: 4 },
    overflowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.separator, gap: 8 },
    overflowName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    overflowMeta: { fontSize: fontSize['2sm'], color: colors.textMuted, marginTop: 1 },
    overflowBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
    overflowBtnText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold },
    modalCancel: { paddingVertical: 14, alignItems: 'center' },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textMuted },
})
