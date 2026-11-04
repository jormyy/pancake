import { StyleSheet, Text, View } from 'react-native'
import { MotionPressable } from '@/components/Motion'
import { colors, controlSize, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import type { LineupPin } from '@/lib/lineup/pins'

const choices = [{ label: 'Start', pin: 'start' }, { label: 'Auto', pin: null }, { label: 'Bench', pin: 'bench' }] as const

export function LineupPinControl({ name, pin, disabled, onChange }: {
    name: string
    pin: LineupPin
    disabled: boolean
    onChange: (pin: LineupPin) => void
}) {
    return <View style={styles.control} accessibilityRole="radiogroup" accessibilityLabel={`Lineup pin for ${name}`}>
        {choices.map(choice => <MotionPressable key={choice.label}
            style={[styles.segment, choice.pin === pin && styles.selected]}
            disabled={disabled} accessibilityRole="radio"
            accessibilityLabel={choice.pin ? `Pin ${name} to ${choice.pin}` : `Set ${name} to Auto`}
            accessibilityState={{ checked: choice.pin === pin, disabled }}
            onPress={event => { event.stopPropagation(); if (!disabled && choice.pin !== pin) onChange(choice.pin) }}>
            <Text style={[styles.label, choice.pin === pin && styles.selectedLabel]}>{choice.label}</Text>
        </MotionPressable>)}
    </View>
}

const styles = StyleSheet.create({
    control: { flexDirection: 'row', alignSelf: 'flex-end', marginHorizontal: spacing.lg, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radii.md, overflow: 'hidden', maxWidth: '100%' },
    segment: { minHeight: controlSize.minTouch, minWidth: 60, paddingHorizontal: spacing.sm, justifyContent: 'center', alignItems: 'center' },
    selected: { backgroundColor: colors.primaryLight },
    label: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: colors.textMuted },
    selectedLabel: { color: colors.primaryDark, fontWeight: fontWeight.bold },
})
