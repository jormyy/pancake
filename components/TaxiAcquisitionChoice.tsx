import { StyleSheet, Switch, Text, View } from 'react-native'
import { spacing, textStyles } from '@/constants/tokens'

export function TaxiAcquisitionChoice({ value, onChange, disabled = false, label = 'Acquire directly into taxi' }: {
    value: boolean
    onChange: (value: boolean) => void
    disabled?: boolean
    label?: string
}) {
    return <View style={styles.root}>
        <View style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={label} />
        </View>
        <Text style={textStyles.meta}>Once a player leaves your taxi, they cannot return.</Text>
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.xs, paddingVertical: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    label: { ...textStyles.body, flex: 1 },
})
