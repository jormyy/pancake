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
        <Text style={textStyles.meta}>Eligible rookies enter taxi only through drafts or trades. Once a player leaves your team’s taxi, they cannot return to it. Another team’s exit does not block your acquisition.</Text>
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.xs, paddingVertical: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    label: { ...textStyles.body, flex: 1 },
})
