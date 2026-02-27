import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Share,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getLeagueMembers } from '@/lib/league'

const ROLE_LABELS: Record<string, string> = {
  commissioner: 'Commissioner',
  co_commissioner: 'Co-Comm',
  manager: 'Manager',
}

export default function LeagueScreen() {
  const { current, loading: leagueLoading } = useLeagueContext()
  const { user } = useAuth()
  const [members, setMembers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const league = current?.leagues as any
  const isCommissioner = league?.commissioner_id === user?.id

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true)
    try {
      const data = await getLeagueMembers(league.id)
      setMembers(data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [current])

  useFocusEffect(useCallback(() => { load() }, [load]))

  async function shareInviteCode() {
    await Share.share({
      message: `Join my Pancake league! Use invite code: ${league?.invite_code}`,
    })
  }

  if (leagueLoading || (!current && loading)) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
      </SafeAreaView>
    )
  }

  if (!current) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Join or create a league first.</Text>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerInfo}>
            <Text style={styles.leagueName}>{league?.name}</Text>
            <Text style={styles.teamName}>{current.team_name}</Text>
          </View>
          {isCommissioner && (
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => router.push('/(modals)/commissioner-settings')}
            >
              <Text style={styles.settingsButtonText}>⚙ Settings</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Invite code */}
        <TouchableOpacity style={styles.inviteRow} onPress={shareInviteCode} activeOpacity={0.7}>
          <Text style={styles.inviteLabel}>Invite Code</Text>
          <Text style={styles.inviteCode}>{league?.invite_code}</Text>
          <Text style={styles.inviteCopy}>Share</Text>
        </TouchableOpacity>
      </View>

      {/* Members */}
      <Text style={styles.sectionTitle}>Teams ({members.length})</Text>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color="#F97316" />
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m.id}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => {
            const profile = item.profiles as any
            const isMe = item.user_id === user?.id
            return (
              <View style={styles.memberRow}>
                <View style={styles.memberAvatar}>
                  <Text style={styles.memberAvatarText}>
                    {(item.team_name ?? profile?.display_name ?? '?')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={styles.memberInfo}>
                  <Text style={styles.memberTeam}>
                    {item.team_name ?? 'Unnamed Team'}
                    {isMe && <Text style={styles.meTag}> (you)</Text>}
                  </Text>
                  <Text style={styles.memberName}>{profile?.display_name ?? profile?.username}</Text>
                </View>
                <View style={[
                  styles.roleBadge,
                  item.role === 'commissioner' && styles.roleBadgeCommissioner,
                ]}>
                  <Text style={[
                    styles.roleText,
                    item.role === 'commissioner' && styles.roleTextCommissioner,
                  ]}>
                    {ROLE_LABELS[item.role] ?? item.role}
                  </Text>
                </View>
              </View>
            )
          }}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },

  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee', gap: 12 },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerInfo: { flex: 1, gap: 2 },
  leagueName: { fontSize: 20, fontWeight: '800' },
  teamName: { fontSize: 14, color: '#888' },

  settingsButton: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: '#ddd',
  },
  settingsButtonText: { fontSize: 13, fontWeight: '600', color: '#555' },

  inviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f9f9f9', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  inviteLabel: { fontSize: 13, color: '#888', flex: 1 },
  inviteCode: { fontSize: 15, fontWeight: '800', color: '#111', letterSpacing: 2 },
  inviteCopy: { fontSize: 13, color: '#F97316', fontWeight: '600' },

  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#aaa', letterSpacing: 0.5, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },

  memberRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  separator: { height: 1, backgroundColor: '#f3f3f3', marginLeft: 72 },

  memberAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F97316', justifyContent: 'center', alignItems: 'center' },
  memberAvatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  memberInfo: { flex: 1, gap: 2 },
  memberTeam: { fontSize: 15, fontWeight: '600' },
  meTag: { color: '#aaa', fontWeight: '400', fontSize: 13 },
  memberName: { fontSize: 13, color: '#888' },

  roleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#f3f3f3' },
  roleBadgeCommissioner: { backgroundColor: '#FEF3C7' },
  roleText: { fontSize: 11, fontWeight: '700', color: '#888' },
  roleTextCommissioner: { color: '#D97706' },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 14, color: '#aaa' },
})
