import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getMyMatchup, Matchup } from '@/lib/scoring'

export default function HomeScreen() {
  const { memberships, current, setCurrent, loading, refresh } = useLeagueContext()
  const { user } = useAuth()
  const [matchup, setMatchup] = useState<Matchup | null | undefined>(undefined)
  const [matchupLoading, setMatchupLoading] = useState(true)

  const load = useCallback(async () => {
    await refresh()
    if (!current || !user) return
    const league = current.leagues as any
    setMatchupLoading(true)
    try {
      const m = await getMyMatchup(current.id, league.id)
      setMatchup(m)
    } catch (e) {
      console.error(e)
      setMatchup(null)
    } finally {
      setMatchupLoading(false)
    }
  }, [current, user])

  useFocusEffect(useCallback(() => { load() }, [load]))

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

      {/* Matchup card */}
      <View style={styles.matchupSection}>
        {matchupLoading ? (
          <ActivityIndicator color="#F97316" style={{ marginTop: 32 }} />
        ) : matchup ? (
          <MatchupCard matchup={matchup} />
        ) : (
          <View style={styles.noMatchup}>
            <Text style={styles.noMatchupText}>No matchup this week yet.</Text>
            <Text style={styles.noMatchupSub}>Matchups are generated before each week starts.</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}

function MatchupCard({ matchup }: { matchup: Matchup }) {
  const fmt = (n: number | null) => n != null ? n.toFixed(1) : '—'
  const myPts = matchup.myPoints ?? 0
  const oppPts = matchup.opponentPoints ?? 0
  const iWinning = myPts > oppPts

  let statusLabel = 'In Progress'
  let statusColor = '#F97316'
  if (matchup.isFinalized) {
    statusLabel = matchup.iWon ? 'Win' : 'Loss'
    statusColor = matchup.iWon ? '#10B981' : '#EF4444'
  }

  return (
    <View style={styles.matchupCard}>
      <View style={styles.matchupHeader}>
        <Text style={styles.matchupWeek}>Week {matchup.weekNumber}</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <View style={styles.matchupScores}>
        {/* My side */}
        <View style={[styles.matchupSide, iWinning && !matchup.isFinalized && styles.winningSide]}>
          <Text style={styles.matchupTeam} numberOfLines={1}>{matchup.myTeamName}</Text>
          <Text style={[styles.matchupScore, iWinning && styles.winningScore]}>
            {fmt(matchup.myPoints)}
          </Text>
        </View>

        <Text style={styles.matchupVs}>vs</Text>

        {/* Opponent side */}
        <View style={[styles.matchupSide, styles.matchupSideRight, !iWinning && !matchup.isFinalized && styles.winningSide]}>
          <Text style={styles.matchupTeam} numberOfLines={1}>{matchup.opponentTeamName}</Text>
          <Text style={[styles.matchupScore, !iWinning && styles.winningScore]}>
            {fmt(matchup.opponentPoints)}
          </Text>
        </View>
      </View>
    </View>
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

  matchupSection: { flex: 1, padding: 20 },

  matchupCard: {
    backgroundColor: '#fff', borderRadius: 16,
    borderWidth: 1, borderColor: '#eee',
    padding: 20, gap: 16,
    shadowColor: '#000', shadowOpacity: 0.06,
    shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  matchupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  matchupWeek: { fontSize: 13, fontWeight: '700', color: '#aaa', letterSpacing: 0.5 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusText: { fontSize: 12, fontWeight: '700' },

  matchupScores: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  matchupSide: { flex: 1, gap: 4 },
  matchupSideRight: { alignItems: 'flex-end' },
  winningSide: {},
  matchupTeam: { fontSize: 13, color: '#888', fontWeight: '500' },
  matchupScore: { fontSize: 36, fontWeight: '800', color: '#ccc' },
  winningScore: { color: '#111' },
  matchupVs: { fontSize: 14, color: '#ccc', fontWeight: '600', paddingHorizontal: 4 },

  noMatchup: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  noMatchupText: { fontSize: 16, fontWeight: '600', color: '#555' },
  noMatchupSub: { fontSize: 13, color: '#aaa', textAlign: 'center' },

  noLeague: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  noLeagueTitle: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
  noLeagueSub: { fontSize: 15, color: '#888', textAlign: 'center', marginBottom: 8 },
  primaryButton: { width: '100%', height: 52, backgroundColor: '#F97316', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryButton: { width: '100%', height: 52, borderWidth: 1.5, borderColor: '#F97316', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  secondaryButtonText: { color: '#F97316', fontWeight: '700', fontSize: 16 },
})
