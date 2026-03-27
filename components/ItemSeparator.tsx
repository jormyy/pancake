import { View, StyleSheet } from 'react-native'
import { colors } from '@/constants/tokens'

/** Standard 1px list separator with left inset for avatar rows */
export function ItemSeparator() {
    return <View style={styles.separator} />
}

const styles = StyleSheet.create({
    separator: { height: 1, backgroundColor: colors.separator, marginLeft: 72 },
})
