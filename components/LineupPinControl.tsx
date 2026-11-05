import { StyleSheet, Text, View } from 'react-native'
import { MotionPressable } from '@/components/Motion'
import { colors, componentTokens, controlSize, radii, spacing } from '@/constants/tokens'
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
            aria-checked={choice.pin === pin}
            accessibilityLabel={choice.pin ? `Pin ${name} to ${choice.pin}` : `Set ${name} to Auto`}
            accessibilityState={{ checked: choice.pin === pin, disabled }}
            onPress={event => { event.stopPropagation(); if (!disabled && choice.pin !== pin) onChange(choice.pin) }}>
            <Text style={[styles.label, choice.pin === pin && styles.selectedLabel]}>{choice.label}</Text>
        </MotionPressable>)}
    </View>
}

const styles = StyleSheet.create({
    control: { flexDirection: 'row', alignSelf: 'stretch', marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.xxs, gap: spacing.xxs, backgroundColor: colors.bgSubtle, borderRadius: radii.md, maxWidth: '100%' },
    segment: { flex: 1, minWidth: controlSize.minTouch, minHeight: controlSize.minTouch, borderRadius: radii.sm, paddingHorizontal: spacing.sm, justifyContent: 'center', alignItems: 'center' },
    selected: { backgroundColor: colors.bgCard },
    label: { ...componentTokens.segmentedControl.pillLabel, color: colors.textMuted },
    selectedLabel: { color: colors.primaryDark },
})
