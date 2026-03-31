import { View, Text, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { colors } from '@/constants/tokens'

export function NoLeagueState() {
    const { push } = useRouter()
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.inner}>
                <Text style={styles.title}>Welcome to Pancake</Text>
                <Text style={styles.sub}>Create a new league or join one with an invite code.</Text>
                <Pressable style={styles.primaryButton} onPress={() => push('/(modals)/create-league')}>
                    <Text style={styles.primaryButtonText}>Create a League</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={() => push('/(modals)/join-league')}>
                    <Text style={styles.secondaryButtonText}>Join with Invite Code</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    inner: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
    title: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
    sub: { fontSize: 15, color: colors.textMuted, textAlign: 'center', marginBottom: 8 },
    primaryButton: { width: '100%', height: 52, backgroundColor: colors.primary, borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    primaryButtonText: { color: colors.textWhite, fontWeight: '700', fontSize: 16 },
    secondaryButton: { width: '100%', height: 52, borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, borderCurve: 'continuous' as const, justifyContent: 'center', alignItems: 'center' },
    secondaryButtonText: { color: colors.primary, fontWeight: '700', fontSize: 16 },
})
