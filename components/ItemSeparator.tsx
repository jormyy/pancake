import { View, StyleSheet } from 'react-native'
import { colors } from '@/constants/tokens'

/** Standard 1px list separator, unbroken edge-to-edge */
export function ItemSeparator() {
    return (
        <View
            style={styles.separator}
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        />
    )
}

const styles = StyleSheet.create({
    separator: { height: 1, backgroundColor: colors.separator },
})
