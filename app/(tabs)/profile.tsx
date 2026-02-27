import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { signOut } from '@/lib/auth'

export default function ProfileScreen() {
  async function handleSignOut() {
    try {
      await signOut()
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.sub}>Settings & account coming soon</Text>
        <TouchableOpacity style={styles.signOut} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  inner: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
  sub: { fontSize: 15, color: '#888' },
  signOut: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  signOutText: { fontSize: 15, color: '#d00', fontWeight: '600' },
})
