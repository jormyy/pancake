import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'

export default function HomeScreen() {
  const { memberships, current, setCurrent, loading, refresh } = useLeagueContext()

  useFocusEffect(useCallback(() => { refresh() }, [refresh]))

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
      </SafeAreaView>
    )
  }

  if (memberships.length === 0) {
    return <NoLeagueState />
  }

  const league = current?.leagues as any

  return (
    <SafeAreaView style={styles.container}>
      {/* League switcher */}
      {memberships.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.switcherRow}
          contentContainerStyle={styles.switcherContent}
        >
          {memberships.map((m) => {
            const l = m.leagues as any
            const isActive = m.id === current?.id
            return (
              <TouchableOpacity
                key={m.id}
                style={[styles.switcherChip, isActive && styles.switcherChipActive]}
                onPress={() => setCurrent(m)}
              >
                <Text style={[styles.switcherText, isActive && styles.switcherTextActive]}>
                  {l?.name ?? 'League'}
                </Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      )}

      {/* League header */}
      <View style={styles.leagueHeader}>
        <Text style={styles.leagueName}>{league?.name}</Text>
        <Text style={styles.teamName}>{current?.team_name}</Text>
      </View>

      {/* Placeholder */}
      <View style={styles.placeholder}>
        <Text style={styles.placeholderText}>Matchup & scores coming soon</Text>
      </View>
    </SafeAreaView>
  )
}

function NoLeagueState() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.noLeague}>
        <Text style={styles.noLeagueTitle}>Welcome to Pancake</Text>
        <Text style={styles.noLeagueSub}>Create a new league or join one with an invite code.</Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.push('/(modals)/create-league')}
        >
          <Text style={styles.primaryButtonText}>Create a League</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.push('/(modals)/join-league')}
        >
          <Text style={styles.secondaryButtonText}>Join with Invite Code</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: '#eee' },
  switcherContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8, paddingVertical: 8 },
  switcherChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: '#f3f3f3' },
  switcherChipActive: { backgroundColor: '#F97316' },
  switcherText: { fontSize: 13, fontWeight: '600', color: '#555' },
  switcherTextActive: { color: '#fff' },
  leagueHeader: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee' },
  leagueName: { fontSize: 22, fontWeight: '800' },
  teamName: { fontSize: 14, color: '#888', marginTop: 2 },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  placeholderText: { fontSize: 15, color: '#aaa' },
  noLeague: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  noLeagueTitle: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
  noLeagueSub: { fontSize: 15, color: '#888', textAlign: 'center', marginBottom: 8 },
  primaryButton: { width: '100%', height: 52, backgroundColor: '#F97316', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryButton: { width: '100%', height: 52, borderWidth: 1.5, borderColor: '#F97316', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  secondaryButtonText: { color: '#F97316', fontWeight: '700', fontSize: 16 },
})
