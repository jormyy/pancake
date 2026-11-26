import { useState } from 'react'
import { useUnsentFormUpdate } from '@/hooks/use-unsent-form-update'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { borderWidth, colors, controlSize, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import type { TradeBlockItem } from '@/lib/trades'

export function TradeBlockNoteButton({ label, disabled, onPress }: {
    label: string
    disabled: boolean
    onPress: () => void
}) {
    return <Pressable style={styles.noteButton} accessibilityRole="button" disabled={disabled}
        accessibilityState={{ disabled }} accessibilityLabel={`Edit trade block note for ${label}`}
        onPress={onPress}>
        <MaterialIcons name="edit" size={controlSize.icon.sm} color={colors.primaryDark} />
        <Text style={styles.noteButtonText}>Note</Text>
    </Pressable>
}

export function TradeBlockNoteEditor({ item, label, disabled, onSave, onClose }: {
    item: TradeBlockItem
    label: string
    disabled: boolean
    onSave: (item: TradeBlockItem, note: string) => Promise<boolean | undefined>
    onClose: () => void
}) {
    const [note, setNote] = useState(item.note ?? '')
    const [saving, setSaving] = useState(false)
    useUnsentFormUpdate(note !== (item.note ?? ''), 'trade block note')
    return <View style={styles.editor}>
        <TextInput style={styles.input} value={note} onChangeText={setNote} maxLength={280} multiline
            editable={!disabled && !saving} accessibilityLabel={`Trade block note for ${label}`}
            placeholder="What do you want in return?" placeholderTextColor={colors.inputPlaceholder} />
        <View style={styles.actions}>
            <Button title="Cancel" variant="secondary" size="sm" disabled={saving} onPress={onClose} />
            <Button title="Save note" size="sm" disabled={disabled || saving} onPress={async () => {
                setSaving(true)
                try { if (await onSave(item, note)) onClose() } finally { setSaving(false) }
            }} />
        </View>
    </View>
}

const styles = StyleSheet.create({
    noteButton: {
        minWidth: controlSize.minTouch,
        minHeight: controlSize.minTouch,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous',
        borderWidth: borderWidth.thin,
        borderColor: colors.primaryBorder,
        paddingHorizontal: spacing.md,
    },
    noteButtonText: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.primaryDark },
    editor: { width: '100%', minWidth: 0, gap: spacing.sm, paddingVertical: spacing.sm },
    input: { ...textStyles.body, ...typeScale.title, width: '100%', minWidth: 0, backgroundColor: colors.bgInput, borderRadius: radii.md, padding: spacing.md, minHeight: controlSize.minTouch },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm },
})
