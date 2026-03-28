import { ActivityIndicator, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '@/constants/tokens'

/** Full-screen centered spinner — replaces the loading guard in every tab/modal */
export function LoadingScreen() {
    return (
        <SafeAreaView style={styles.container}>
            <ActivityIndicator style={styles.spinner} color={colors.primary} />
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    spinner: { flex: 1 },
})
