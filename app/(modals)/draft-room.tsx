import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  FlatList, ActivityIndicator, Alert, ScrollView,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, router } from 'expo-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import {
  getDraftState, subscribeToDraft, unsubscribeFromDraft,
  nominatePlayer, placeBid, searchPlayers,
  DraftState, Nomination,
} from '@/lib/draft'
import { RealtimeChannel } from '@supabase/supabase-js'

type DraftTab = 'budgets' | 'history'

export default function DraftRoomScreen() {
  const { draftId } = useLocalSearchParams<{ draftId: string }>()
  const { user } = useAuth()
  const { current } = useLeagueContext()

  const [state, setState] = useState<DraftState | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<DraftTab>('budgets')

  // Bidding
  const [bidAmount, setBidAmount] = useState(2)
  const [bidding, setBidding] = useState(false)

  // Nomination / player search
  const [nominating, setNominating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [submittingNom, setSubmittingNom] = useState(false)

  // Countdown timer
  const [timeLeft, setTimeLeft] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const myMemberId = current?.id

  const load = useCallback(async () => {
    if (!draftId) return
    try {
      const s = await getDraftState(draftId)
      setState(s)
      if (s?.openNomination?.countdownExpiresAt) {
        const diff = Math.max(0, Math.floor((new Date(s.openNomination.countdownExpiresAt).getTime() - Date.now()) / 1000))
        setBidAmount(Math.max((s.openNomination.currentBidAmount ?? 1) + 1, 2))
        setTimeLeft(diff)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [draftId])

  // Load + subscribe
  useEffect(() => {
    if (!draftId) return
    load()
    channelRef.current = subscribeToDraft(draftId, load)
    return () => {
      if (channelRef.current) unsubscribeFromDraft(channelRef.current)
    }
  }, [draftId, load])

  // Countdown tick
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (!state?.openNomination) return

    timerRef.current = setInterval(() => {
      const exp = state.openNomination?.countdownExpiresAt
      if (!exp) return
      const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
      setTimeLeft(diff)
    }, 500)

    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [state?.openNomination?.id, state?.openNomination?.countdownExpiresAt])

  // Player search
  useEffect(() => {
    if (!searchQuery.trim() || !draftId) {
      setSearchResults([])
      return
    }
    const timeout = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const results = await searchPlayers(searchQuery, draftId)
        setSearchResults(results)
      } finally {
        setSearchLoading(false)
      }
    }, 300)
    return () => clearTimeout(timeout)
  }, [searchQuery, draftId])

  async function handleBid() {
    if (!state?.openNomination || !myMemberId || !draftId) return
    setBidding(true)
    try {
      await placeBid(draftId, myMemberId, state.openNomination.id, bidAmount)
    } catch (e: any) {
      Alert.alert('Bid failed', e.message)
    } finally {
      setBidding(false)
    }
  }

  async function handleNominate(playerId: string, playerName: string) {
    if (!myMemberId || !draftId) return
    setSubmittingNom(true)
    try {
      await nominatePlayer(draftId, myMemberId, playerId)
      setNominating(false)
      setSearchQuery('')
      setSearchResults([])
    } catch (e: any) {
      Alert.alert('Nomination failed', e.message)
    } finally {
      setSubmittingNom(false)
    }
  }

  if (loading || !state) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
      </SafeAreaView>
    )
  }

  const { draft, order, budgets, openNomination, currentNominatorMemberId, nominations } = state
  const isMyTurn = currentNominatorMemberId === myMemberId
  const currentNominatorTeam = order.find((o) => o.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

  const myBudget = budgets.find((b) => b.memberId === myMemberId)
  const iAmLeading = openNomination?.currentBidderId === myMemberId
  const leadingTeam = budgets.find((b) => b.memberId === openNomination?.currentBidderId)?.teamName
  const closedNominations = nominations.filter((n) => n.status !== 'open').reverse()

  // Min bid is always current + 1 (or 1 if no bids yet)
  const minBid = (openNomination?.currentBidAmount ?? 0) + 1

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Auction Draft</Text>
        {myBudget && (
          <View style={styles.budgetChip}>
            <Text style={styles.budgetChipText}>${myBudget.remaining} left</Text>
          </View>
        )}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Nomination on the clock */}
        {openNomination ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>ON THE BLOCK</Text>
            <Text style={styles.playerName}>{openNomination.player?.displayName ?? 'Unknown Player'}</Text>
            <Text style={styles.playerMeta}>
              {openNomination.player?.nbaTeam ?? '—'} · {openNomination.player?.position ?? '—'}
            </Text>

            <View style={styles.bidRow}>
              <View style={styles.bidInfo}>
                <Text style={styles.bidAmount}>${openNomination.currentBidAmount}</Text>
                <Text style={styles.bidLeader}>
                  {iAmLeading ? "You're leading" : `${leadingTeam ?? '—'} leads`}
                </Text>
              </View>
              <View style={[styles.countdown, timeLeft <= 10 && styles.countdownUrgent]}>
                <Text style={[styles.countdownText, timeLeft <= 10 && styles.countdownTextUrgent]}>
                  0:{String(timeLeft).padStart(2, '0')}
                </Text>
              </View>
            </View>

            {!iAmLeading && (
              <View style={styles.bidInputRow}>
                <TouchableOpacity
                  style={styles.bidStep}
                  onPress={() => setBidAmount((v) => Math.max(minBid, v - 1))}
                >
                  <Text style={styles.bidStepText}>−</Text>
                </TouchableOpacity>
                <Text style={styles.bidAmountInput}>${bidAmount}</Text>
                <TouchableOpacity
                  style={styles.bidStep}
                  onPress={() => setBidAmount((v) => Math.min((myBudget?.remaining ?? 999), v + 1))}
                >
                  <Text style={styles.bidStepText}>+</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.bidButton, bidding && styles.bidButtonDisabled]}
                  onPress={handleBid}
                  disabled={bidding || bidAmount <= openNomination.currentBidAmount || iAmLeading || timeLeft === 0}
                >
                  {bidding
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.bidButtonText}>Bid ${bidAmount}</Text>
                  }
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          /* No open nomination — show whose turn it is */
          <View style={styles.card}>
            {isMyTurn ? (
              <>
                <Text style={styles.yourTurnBanner}>Your turn to nominate!</Text>
                {nominating ? (
                  <>
                    <TextInput
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Search player name..."
                      autoFocus
                    />
                    {searchLoading ? (
                      <ActivityIndicator style={{ marginTop: 12 }} color="#F97316" />
                    ) : (
                      <FlatList
                        data={searchResults}
                        keyExtractor={(p) => p.id}
                        scrollEnabled={false}
                        renderItem={({ item }) => (
                          <TouchableOpacity
                            style={styles.playerResult}
                            onPress={() => handleNominate(item.id, item.display_name)}
                            disabled={submittingNom}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={styles.playerResultName}>{item.display_name}</Text>
                              <Text style={styles.playerResultMeta}>{item.nba_team ?? '—'} · {item.position ?? '—'}</Text>
                            </View>
                            {submittingNom
                              ? <ActivityIndicator size="small" color="#F97316" />
                              : <Text style={styles.nominateLabel}>Nominate</Text>
                            }
                          </TouchableOpacity>
                        )}
                        ListEmptyComponent={
                          searchQuery.length > 0 && !searchLoading ? (
                            <Text style={styles.emptySearch}>No players found</Text>
                          ) : null
                        }
                      />
                    )}
                    <TouchableOpacity style={styles.cancelNomButton} onPress={() => { setNominating(false); setSearchQuery(''); setSearchResults([]) }}>
                      <Text style={styles.cancelNomText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <TouchableOpacity style={styles.nominateButton} onPress={() => setNominating(true)}>
                    <Text style={styles.nominateButtonText}>Search & Nominate a Player</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <View style={styles.waitingRow}>
                <Text style={styles.waitingText}>Waiting for</Text>
                <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
                <Text style={styles.waitingText}>to nominate...</Text>
              </View>
            )}
          </View>
        )}

        {/* Tab switcher */}
        <View style={styles.tabRow}>
          {(['budgets', 'history'] as DraftTab[]).map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.tabChip, tab === t && styles.tabChipActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                {t === 'budgets' ? 'Budgets' : `History (${closedNominations.length})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'budgets' ? (
          <View style={styles.card}>
            {budgets
              .slice()
              .sort((a, b) => b.remaining - a.remaining)
              .map((b, i) => (
                <View key={b.memberId} style={[styles.budgetRow, i > 0 && styles.budgetDivider]}>
                  <Text style={[styles.budgetTeam, b.memberId === myMemberId && styles.meAccent]} numberOfLines={1}>
                    {b.teamName}{b.memberId === myMemberId ? ' (you)' : ''}
                  </Text>
                  <Text style={[styles.budgetAmount, b.memberId === myMemberId && styles.meAccent]}>
                    ${b.remaining}
                  </Text>
                </View>
              ))}
          </View>
        ) : (
          closedNominations.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No players sold yet.</Text>
            </View>
          ) : (
            <View style={styles.card}>
              {closedNominations.map((n, i) => {
                const winnerTeam = budgets.find((b) => b.memberId === n.winningMemberId)?.teamName
                return (
                  <View key={n.id} style={[styles.historyRow, i > 0 && styles.budgetDivider]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyPlayer}>{n.player?.displayName ?? 'Unknown'}</Text>
                      <Text style={styles.historyMeta}>
                        {n.status === 'sold' ? winnerTeam ?? '—' : 'No bid'}
                      </Text>
                    </View>
                    {n.status === 'sold' && (
                      <Text style={styles.historyPrice}>${n.finalPrice}</Text>
                    )}
                    {n.status === 'no_bid' && (
                      <Text style={styles.historyNoBid}>FA</Text>
                    )}
                  </View>
                )
              })}
            </View>
          )
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  headerTitle: { fontSize: 18, fontWeight: '800' },
  budgetChip: {
    backgroundColor: '#FFF7ED', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20,
    borderWidth: 1, borderColor: '#FDBA74',
  },
  budgetChipText: { fontSize: 13, fontWeight: '700', color: '#EA580C' },

  card: {
    backgroundColor: '#fff', borderRadius: 14,
    borderWidth: 1, borderColor: '#eee', padding: 16, gap: 8,
  },
  cardLabel: { fontSize: 11, fontWeight: '700', color: '#aaa', letterSpacing: 0.5 },

  playerName: { fontSize: 22, fontWeight: '800', color: '#111' },
  playerMeta: { fontSize: 13, color: '#888' },

  bidRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  bidInfo: { gap: 2 },
  bidAmount: { fontSize: 28, fontWeight: '800', color: '#F97316' },
  bidLeader: { fontSize: 13, color: '#888' },

  countdown: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: '#f3f3f3', justifyContent: 'center', alignItems: 'center',
  },
  countdownUrgent: { backgroundColor: '#FEE2E2' },
  countdownText: { fontSize: 18, fontWeight: '800', color: '#555' },
  countdownTextUrgent: { color: '#EF4444' },

  bidInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  bidStep: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#f3f3f3', justifyContent: 'center', alignItems: 'center',
  },
  bidStepText: { fontSize: 20, fontWeight: '600', color: '#555' },
  bidAmountInput: { fontSize: 18, fontWeight: '800', minWidth: 48, textAlign: 'center' },
  bidButton: {
    flex: 1, height: 44, backgroundColor: '#F97316', borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
  },
  bidButtonDisabled: { opacity: 0.5 },
  bidButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  yourTurnBanner: { fontSize: 16, fontWeight: '800', color: '#F97316', textAlign: 'center' },
  nominateButton: {
    marginTop: 4, height: 48, backgroundColor: '#F97316', borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
  },
  nominateButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  searchInput: {
    height: 44, backgroundColor: '#f3f3f3', borderRadius: 10,
    paddingHorizontal: 14, fontSize: 15, marginTop: 4,
  },

  playerResult: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f3f3f3', gap: 8,
  },
  playerResultName: { fontSize: 15, fontWeight: '600' },
  playerResultMeta: { fontSize: 12, color: '#888', marginTop: 1 },
  nominateLabel: { fontSize: 13, fontWeight: '700', color: '#F97316' },
  emptySearch: { fontSize: 13, color: '#aaa', textAlign: 'center', marginTop: 8 },
  cancelNomButton: { marginTop: 8, alignItems: 'center' },
  cancelNomText: { fontSize: 14, color: '#888', fontWeight: '600' },

  waitingRow: { alignItems: 'center', gap: 4, paddingVertical: 8 },
  waitingText: { fontSize: 14, color: '#888' },
  waitingTeam: { fontSize: 18, fontWeight: '800', color: '#111' },

  tabRow: { flexDirection: 'row', gap: 8 },
  tabChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f3f3f3' },
  tabChipActive: { backgroundColor: '#F97316' },
  tabChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
  tabChipTextActive: { color: '#fff' },

  budgetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  budgetDivider: { borderTopWidth: 1, borderTopColor: '#f3f3f3' },
  budgetTeam: { flex: 1, fontSize: 14, fontWeight: '600', color: '#111' },
  budgetAmount: { fontSize: 16, fontWeight: '800', color: '#111' },
  meAccent: { color: '#F97316' },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  historyPlayer: { fontSize: 14, fontWeight: '600' },
  historyMeta: { fontSize: 12, color: '#888', marginTop: 1 },
  historyPrice: { fontSize: 15, fontWeight: '800', color: '#111' },
  historyNoBid: { fontSize: 12, fontWeight: '700', color: '#aaa', backgroundColor: '#f3f3f3', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },

  empty: { alignItems: 'center', paddingVertical: 24 },
  emptyText: { fontSize: 13, color: '#aaa' },
})
