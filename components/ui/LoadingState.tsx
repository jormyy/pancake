import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

export function LoadingState({ style }: { style?: StyleProp<ViewStyle> }) {
    return <View style={[styles.wrap, style]} aria-busy accessibilityState={{ busy: true }} />
}

const styles = StyleSheet.create({
    wrap: { flex: 1, minHeight: 320, alignSelf: 'stretch' },
})
