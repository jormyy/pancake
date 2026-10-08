import { View, Text, StyleSheet } from 'react-native'
import type { RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { playerHeadshotUrl } from '@/lib/format'

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
    const close = () => {
        if (dropping === null) onCancel()
    }
    return (
        <Sheet visible={visible} onClose={close} title={title}>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            <View style={styles.list}>
                {roster.map((rp) => {
                    const p = rp.players
                    const ep = getEligiblePositions(p)
                    return (
                        <View key={rp.id} style={styles.row}>
                            <Avatar
                                name={p.display_name}
                                uri={playerHeadshotUrl(p.nba_id) ?? undefined}
                                color={colors.bgMuted}
                                size={36}
                            />
                            <View style={styles.info}>
                                <Text style={textStyles.rowTitle} numberOfLines={1}>{p.display_name}</Text>
                                <View style={styles.metaRow}>
                                    {p.nba_team ? <Text style={textStyles.meta}>{p.nba_team}</Text> : null}
                                    {ep.map((pos) => <PosTag key={pos} position={pos} />)}
                                </View>
                            </View>
                            <Button
                                title="Drop"
                                size="sm"
                                variant="danger"
                                onPress={() => onDrop(rp)}
                                disabled={dropping !== null}
                                loading={dropping === rp.id}
                                accessibilityLabel={`Drop ${p.display_name}`}
                            />
                        </View>
                    )
                })}
            </View>
            <Button
                title="Cancel"
                variant="ghost"
                onPress={onCancel}
                disabled={dropping !== null}
                accessibilityLabel="Cancel drop player"
                fullWidth
                style={styles.cancel}
            />
        </Sheet>
    )
}

const styles = StyleSheet.create({
    subtitle: { ...textStyles.body, marginBottom: spacing.md },
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
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    cancel: { marginTop: spacing.md },
})
