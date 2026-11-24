import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { MotionPressable } from '@/components/Motion'
import { Sheet } from '@/components/ui/Sheet'
import { colors, componentTokens, controlSize, fontWeight, radii, spacing, typeScale } from '@/constants/tokens'
import type { LineupPin } from '@/lib/lineup/pins'

const choices = [{ label: 'Start', pin: 'start' }, { label: 'Auto', pin: null }, { label: 'Bench', pin: 'bench' }] as const

export function LineupPinControl({ name, pin, disabled, onChange, compact = false }: {
    name: string
    pin: LineupPin
    disabled: boolean
    onChange: (pin: LineupPin) => void
    compact?: boolean
}) {
    const [open, setOpen] = useState(false)
    const current = choices.find(choice => choice.pin === pin) ?? choices[1]
    const radios = (list: boolean) => <View style={list ? styles.list : styles.control} accessibilityRole="radiogroup" accessibilityLabel={`Lineup pin for ${name}`}>
        {choices.map(choice => <MotionPressable key={choice.label}
            style={[list ? styles.option : styles.segment, choice.pin === pin && (list ? styles.optionSelected : styles.selected)]}
            disabled={disabled} accessibilityRole="radio"
            aria-checked={choice.pin === pin}
            accessibilityLabel={choice.pin ? `Pin ${name} to ${choice.pin}` : `Set ${name} to Auto`}
            accessibilityState={{ checked: choice.pin === pin, disabled }}
            onPress={event => {
                event.stopPropagation()
                setOpen(false)
                if (!disabled && choice.pin !== pin) onChange(choice.pin)
            }}>
            <Text style={[list ? styles.optionLabel : styles.label, choice.pin === pin && styles.selectedLabel]}>{choice.label}</Text>
        </MotionPressable>)}
    </View>
    if (!compact) return radios(false)
    return <>
        <MotionPressable style={[styles.trigger, pin != null && styles.triggerPinned]} disabled={disabled}
            accessibilityRole="button" accessibilityLabel={`Lineup pin for ${name}: ${current.label}`}
            accessibilityState={{ disabled, expanded: open }}
            onPress={event => { event.stopPropagation(); setOpen(true) }}>
            <Text style={[styles.label, pin != null && styles.selectedLabel]}>{current.label}</Text>
            {disabled ? null : <MaterialIcons name="expand-more" size={controlSize.icon.sm} color={pin != null ? colors.primaryDark : colors.textMuted} aria-hidden />}
        </MotionPressable>
        <Sheet visible={open} title={`Pin ${name}`} onClose={() => setOpen(false)}>
            {radios(true)}
        </Sheet>
    </>
}

const styles = StyleSheet.create({
    control: { flexDirection: 'row', flexShrink: 0, padding: spacing.xxs, gap: spacing.xxs, backgroundColor: colors.bgSubtle, borderRadius: radii.md },
    segment: { minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, borderRadius: radii.sm, paddingHorizontal: spacing.sm, justifyContent: 'center', alignItems: 'center' },
    selected: { backgroundColor: colors.bgCard },
    label: { ...componentTokens.segmentedControl.pillLabel, color: colors.textMuted },
    selectedLabel: { color: colors.primaryDark },
    trigger: { flexDirection: 'row', flexShrink: 0, alignItems: 'center', justifyContent: 'center', gap: spacing.xxs, minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, paddingHorizontal: spacing.sm, borderRadius: radii.md, backgroundColor: colors.bgSubtle },
    triggerPinned: { backgroundColor: colors.primaryLight },
    list: { gap: spacing.xxs },
    option: { minHeight: controlSize.minTouch, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radii.md },
    optionSelected: { backgroundColor: colors.primaryLight },
    optionLabel: { ...typeScale.row, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
