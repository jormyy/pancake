import { Image, StyleSheet } from 'react-native'

export function AuthBrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <Image
            source={require('@/assets/images/pancake_logo.png')}
            style={compact ? styles.markCompact : styles.mark}
            resizeMode="contain"
        />
    )
}

const styles = StyleSheet.create({
    mark: {
        width: 96,
        height: 96,
    },
    markCompact: {
        width: 72,
        height: 72,
    },
})
