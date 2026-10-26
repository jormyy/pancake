import { useState } from 'react'
import { useUnsentFormUpdate } from '@/hooks/use-unsent-form-update'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { colors, fontSize, foundation, radii, spacing, textStyles } from '@/constants/tokens'
import type { TradeBlockItem } from '@/lib/trades'

export function TradeBlockNoteEditor({ item, label, disabled, onSave }: {
    item: TradeBlockItem
    label: string
    disabled: boolean
    onSave: (item: TradeBlockItem, note: string) => Promise<boolean | undefined>
}) {
    const [editing, setEditing] = useState(false)
    const [note, setNote] = useState(item.note ?? '')
    const [saving, setSaving] = useState(false)
    useUnsentFormUpdate(editing && note !== (item.note ?? ''), 'trade block note')
    if (!editing) return <Pressable style={styles.edit} accessibilityRole="button" disabled={disabled}
        accessibilityLabel={`Edit trade block note for ${label}`} onPress={() => { setNote(item.note ?? ''); setEditing(true) }}>
        <Text style={textStyles.meta} numberOfLines={2}>{item.note || 'Add note'}</Text>
    </Pressable>
    return <View style={styles.editor}>
        <TextInput style={styles.input} value={note} onChangeText={setNote} maxLength={280} multiline
            editable={!disabled && !saving} accessibilityLabel={`Trade block note for ${label}`}
            placeholder="What do you want in return?" placeholderTextColor={colors.inputPlaceholder} />
        <View style={styles.actions}>
            <Button title="Cancel" variant="secondary" size="sm" disabled={saving} onPress={() => setEditing(false)} />
            <Button title="Save note" size="sm" disabled={disabled || saving} onPress={async () => {
                setSaving(true)
                try { if (await onSave(item, note)) setEditing(false) } finally { setSaving(false) }
            }} />
        </View>
    </View>
}

const styles = StyleSheet.create({
    edit: { minHeight: foundation.minTouch, justifyContent: 'center' },
    editor: { width: '100%', minWidth: 0, gap: spacing.sm, paddingVertical: spacing.sm },
    input: { ...textStyles.body, fontSize: fontSize.lg, width: '100%', minWidth: 0, backgroundColor: colors.bgInput, borderRadius: radii.md, padding: spacing.md, minHeight: foundation.minTouch },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm },
})
