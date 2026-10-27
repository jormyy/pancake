import { StyleSheet, Switch, Text, View } from 'react-native'
import { componentTokens, controlSize, textStyles } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

type Action = { title: string; label: string; onPress: () => void }

type Props = {
    actions: Action[]
    disabled?: boolean
    automatic: boolean
    automaticDisabled?: boolean
    onAutomaticChange: (enabled: boolean) => void
}

export function LineupControls({ actions, disabled, automatic, automaticDisabled, onAutomaticChange }: Props) {
    return <>
        <View style={styles.actions}>
            {actions.map(({ title, label, onPress }) => <MotionPressable key={label}
                style={[styles.action, title === 'Rest of season' && styles.seasonAction]}
                onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
                <Text style={styles.actionLabel} numberOfLines={1}>{title}</Text>
            </MotionPressable>)}
        </View>
        <MotionPressable style={styles.preference} onPress={() => onAutomaticChange(!automatic)} disabled={automaticDisabled}
            accessibilityRole="switch" aria-checked={automatic} accessibilityLabel="Keep lineup updated automatically"
            accessibilityState={{ checked: automatic, disabled: automaticDisabled }}>
            <Text style={styles.preferenceLabel}>Keep updated automatically</Text>
            <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Switch value={automatic} onValueChange={onAutomaticChange} disabled={automaticDisabled} />
            </View>
        </MotionPressable>
    </>
}

const styles = StyleSheet.create({
    actions: { flexDirection: 'row', gap: componentTokens.lineupControls.gap },
    action: { ...componentTokens.lineupControls.action, alignItems: 'center', justifyContent: 'center' },
    seasonAction: { flex: componentTokens.lineupControls.seasonFlex },
    actionLabel: { ...componentTokens.lineupControls.label },
    preference: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: componentTokens.lineupControls.gap, minHeight: controlSize.minTouch },
    preferenceLabel: { ...textStyles.body, flex: 1 },
})
