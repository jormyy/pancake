import { View, Text, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, fontSize, fontWeight } from '@/constants/tokens'

type Props = {
    message: string
    /** Wrap in SafeAreaView for full-screen usage (default: true) */
    fullScreen?: boolean
}

/** Centered message for empty lists or missing-league guards */
export function EmptyState({ message, fullScreen = true }: Props) {
    const content = (
        <View style={styles.inner}>
            <Text style={styles.text}>{message}</Text>
        </View>
    )

    if (!fullScreen) return content

    return <SafeAreaView style={styles.container}>{content}</SafeAreaView>
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    text: { color: colors.textMuted, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
})
