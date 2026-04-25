import {
    View,
    Text,
    Pressable,
    ScrollView,
    Modal,
    ActivityIndicator,
    StyleSheet,
} from 'react-native'
import type { RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { getPositionColor } from '@/constants/positions'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'

type Props = {
    visible: boolean
    title: string
    subtitle?: string
    roster: RosterPlayer[]
    dropping: string | null
    onDrop: (rp: RosterPlayer) => void
    onCancel: () => void
}

export function DropPlayerPickerModal({ visible, title, subtitle, roster, dropping, onDrop, onCancel }: Props) {
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
            <View style={styles.overlay}>
                <View style={styles.card}>
                    <Text style={styles.title}>{title}</Text>
                    {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                    <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                        {roster.map((rp) => {
                            const p = rp.players
                            const ep = getEligiblePositions(p)
                            return (
                                <View key={rp.id} style={styles.row}>
                                    <Avatar name={p.display_name} color={getPositionColor(ep[0])} size={38} />
                                    <View style={styles.info}>
                                        <Text style={styles.name} numberOfLines={1}>{p.display_name}</Text>
                                        <View style={styles.metaRow}>
                                            {p.nba_team ? <Text style={styles.meta}>{p.nba_team}</Text> : null}
                                            {ep.map((pos) => <PosTag key={pos} position={pos} />)}
                                        </View>
                                    </View>
                                    <Pressable
                                        style={styles.dropBtn}
                                        onPress={() => onDrop(rp)}
                                        disabled={dropping !== null}
                                    >
                                        {dropping === rp.id
                                            ? <ActivityIndicator size="small" color={colors.textWhite} />
                                            : <Text style={styles.dropBtnText}>Drop</Text>}
                                    </Pressable>
                                </View>
                            )
                        })}
                    </ScrollView>
                    <Pressable style={styles.cancel} onPress={onCancel} disabled={dropping !== null}>
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    card: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    title: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    subtitle: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginBottom: spacing.xl },
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
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
    meta: { fontSize: 12, color: colors.textMuted },
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
    cancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    cancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
