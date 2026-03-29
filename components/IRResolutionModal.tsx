import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Modal,
    ScrollView,
} from 'react-native'
import { useState } from 'react'
import type { RosterPlayer } from '@/lib/roster'
import { POSITION_COLORS } from '@/constants/positions'
import {
    colors,
    palette,
    fontSize,
    fontWeight,
    radii,
    spacing,
} from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'

type Phase = 'ineligible' | 'drop-to-activate'

type Props = {
    visible: boolean
    ineligibleIR: RosterPlayer[]
    activeRoster: RosterPlayer[]
    rosterSize: number
    pendingPlayerName: string
    onActivate: (player: RosterPlayer) => Promise<void>
    onDropAndActivate: (dropPlayer: RosterPlayer, activatePlayer: RosterPlayer) => Promise<void>
    onCancel: () => void
}

export function IRResolutionModal({
    visible,
    ineligibleIR,
    activeRoster,
    rosterSize,
    pendingPlayerName,
    onActivate,
    onDropAndActivate,
    onCancel,
}: Props) {
    const [phase, setPhase] = useState<Phase>('ineligible')
    const [activatingPlayer, setActivatingPlayer] = useState<RosterPlayer | null>(null)
    const [loadingId, setLoadingId] = useState<string | null>(null)

    const activeCount = activeRoster.length
    const hasRoom = activeCount < rosterSize

    function reset() {
        setPhase('ineligible')
        setActivatingPlayer(null)
        setLoadingId(null)
    }

    async function handleActivate(player: RosterPlayer) {
        if (hasRoom) {
            setLoadingId(player.id)
            try {
                await onActivate(player)
            } finally {
                setLoadingId(null)
            }
        } else {
            // Need to drop someone first
            setActivatingPlayer(player)
            setPhase('drop-to-activate')
        }
    }

    async function handleDropAndActivate(dropPlayer: RosterPlayer) {
        if (!activatingPlayer) return
        setLoadingId(dropPlayer.id)
        try {
            await onDropAndActivate(dropPlayer, activatingPlayer)
        } finally {
            setLoadingId(null)
        }
    }

    // Reset internal state when modal opens
    const handleRequestClose = () => {
        reset()
        onCancel()
    }

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={handleRequestClose}
            onShow={() => reset()}
        >
            <View style={styles.modalOverlay}>
                <View style={styles.modalCard}>
                    {phase === 'ineligible' ? (
                        <>
                            <Text style={styles.modalTitle}>Resolve IR Status</Text>
                            <Text style={styles.modalSub}>
                                Activate these players before adding{' '}
                                <Text style={styles.modalPlayerName}>{pendingPlayerName}</Text>
                            </Text>

                            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                                {ineligibleIR.map((rp) => {
                                    const p = rp.players
                                    const isLoading = loadingId === rp.id
                                    return (
                                        <View key={rp.id} style={styles.row}>
                                            <Avatar
                                                name={p.display_name}
                                                color={POSITION_COLORS[p.position ?? ''] ?? palette.gray500}
                                                size={38}
                                            />
                                            <View style={styles.info}>
                                                <Text style={styles.name} numberOfLines={1}>
                                                    {p.display_name}
                                                </Text>
                                                <Text style={styles.meta}>
                                                    {[p.nba_team, p.position].filter(Boolean).join(' · ')}
                                                </Text>
                                            </View>
                                            <Pressable
                                                style={styles.activateBtn}
                                                onPress={() => handleActivate(rp)}
                                                disabled={loadingId !== null}
                                            >
                                                {isLoading ? (
                                                    <ActivityIndicator size="small" color={colors.textWhite} />
                                                ) : (
                                                    <Text style={styles.activateBtnText}>Activate</Text>
                                                )}
                                            </Pressable>
                                        </View>
                                    )
                                })}
                            </ScrollView>
                        </>
                    ) : (
                        <>
                            <Text style={styles.modalTitle}>Drop to Activate</Text>
                            <Text style={styles.modalSub}>
                                Drop a player to activate{' '}
                                <Text style={styles.modalPlayerName}>
                                    {activatingPlayer?.players.display_name}
                                </Text>{' '}
                                from IR
                            </Text>

                            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                                {activeRoster.map((rp) => {
                                    const p = rp.players
                                    const isLoading = loadingId === rp.id
                                    return (
                                        <View key={rp.id} style={styles.row}>
                                            <Avatar
                                                name={p.display_name}
                                                color={POSITION_COLORS[p.position ?? ''] ?? palette.gray500}
                                                size={38}
                                            />
                                            <View style={styles.info}>
                                                <Text style={styles.name} numberOfLines={1}>
                                                    {p.display_name}
                                                </Text>
                                                <Text style={styles.meta}>
                                                    {[p.nba_team, p.position].filter(Boolean).join(' · ')}
                                                </Text>
                                            </View>
                                            <Pressable
                                                style={styles.dropBtn}
                                                onPress={() => handleDropAndActivate(rp)}
                                                disabled={loadingId !== null}
                                            >
                                                {isLoading ? (
                                                    <ActivityIndicator size="small" color={colors.textWhite} />
                                                ) : (
                                                    <Text style={styles.dropBtnText}>Drop</Text>
                                                )}
                                            </Pressable>
                                        </View>
                                    )
                                })}
                            </ScrollView>
                        </>
                    )}

                    <Pressable
                        style={styles.modalCancel}
                        onPress={handleRequestClose}
                        disabled={loadingId !== null}
                    >
                        <Text style={styles.modalCancelText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    modalSub: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        textAlign: 'center',
        marginBottom: spacing.xl,
    },
    modalPlayerName: { color: colors.primary, fontWeight: fontWeight.semibold },

    list: { maxHeight: 360 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.lg,
    },
    info: { flex: 1 },
    name: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    meta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

    activateBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 72,
        alignItems: 'center',
    },
    activateBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },

    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },

    modalCancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    modalCancelText: {
        fontSize: 15,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
})
