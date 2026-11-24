import { StyleSheet, Text, View } from 'react-native'
import { SwitchRow } from '@/components/ui/SwitchRow'
import { spacing, textStyles } from '@/constants/tokens'

export function TaxiAcquisitionChoice({ value, onChange, disabled = false, label = 'Acquire directly into taxi' }: {
    value: boolean
    onChange: (value: boolean) => void
    disabled?: boolean
    label?: string
}) {
    return <View style={styles.root}>
        <SwitchRow accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled}>
            <Text style={styles.label}>{label}</Text>
        </SwitchRow>
        <Text style={textStyles.meta}>Once a player leaves your taxi, they cannot return.</Text>
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.xs, paddingVertical: spacing.sm },
    label: { ...textStyles.body, flex: 1 },
})
