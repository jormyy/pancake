import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { layout } from '@/constants/tokens'

export function LoadingState({ style }: { style?: StyleProp<ViewStyle> }) {
    return <View style={[styles.wrap, style]} aria-busy accessibilityState={{ busy: true }} />
}

const styles = StyleSheet.create({
    wrap: { flex: 1, minHeight: layout.loadingMinHeight, alignSelf: 'stretch' },
})
