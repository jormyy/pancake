import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native'
import { router } from 'expo-router'
import { useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { joinLeague } from '@/lib/league'

export default function JoinLeagueScreen() {
  const { user } = useAuth()
  const [inviteCode, setInviteCode] = useState('')
  const [teamName, setTeamName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleJoin() {
    if (!inviteCode.trim() || !teamName.trim()) {
      setError('Invite code and team name are required.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await joinLeague(inviteCode.trim(), user!.id, teamName.trim())
      router.back()
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.label}>Invite Code</Text>
        <TextInput
          style={[styles.input, styles.codeInput]}
          placeholder="XXXXXX"
          placeholderTextColor="#aaa"
          autoCapitalize="characters"
          autoCorrect={false}
          value={inviteCode}
          onChangeText={(t) => setInviteCode(t.toUpperCase())}
        />

        <Text style={styles.label}>Your Team Name</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Buckets FC"
          placeholderTextColor="#aaa"
          value={teamName}
          onChangeText={setTeamName}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity style={styles.button} onPress={handleJoin} disabled={loading}>
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Join League</Text>
          }
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  inner: { flex: 1, padding: 24, gap: 8 },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginTop: 12 },
  input: {
    height: 50, borderWidth: 1, borderColor: '#ddd', borderRadius: 10,
    paddingHorizontal: 16, fontSize: 16, backgroundColor: '#fafafa',
  },
  codeInput: {
    fontSize: 22, fontWeight: '700', letterSpacing: 6, textAlign: 'center',
  },
  error: { color: '#d00', fontSize: 14, marginTop: 8 },
  button: {
    height: 50, backgroundColor: '#F97316', borderRadius: 10,
    justifyContent: 'center', alignItems: 'center', marginTop: 24,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
})
