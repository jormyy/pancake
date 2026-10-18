import { Image, Platform, StyleSheet } from 'react-native'

export function AuthBrandMark({ compact = false }: { compact?: boolean }) {
    const source = require('@/assets/images/pancake_logo.png')
    const style = compact ? styles.markCompact : styles.mark

    if (Platform.OS === 'web') {
        return (
            <img
                src={source.uri}
                alt=""
                draggable={false}
                width={style.width}
                height={style.height}
                style={{ ...style, display: 'block', objectFit: 'contain', flexShrink: 0 }}
            />
        )
    }

    return (
        <Image
            source={source}
            style={style}
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
