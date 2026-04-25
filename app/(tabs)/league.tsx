import {
    View,
    Text,
    ScrollView,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Share,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getLeagueStandings } from '@/lib/scoring'
import { getActiveDraft, startDraft } from '@/lib/draft'
import { getWaiverPriorityOrder } from '@/lib/waivers'
import { getLeagueTransactions } from '@/lib/transactions'
import { getActiveRookieDraft, startRookieDraft, getAllLeaguePicks, reseedRookieDraftPicks } from '@/lib/rookieDraft'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { StandingsTable, ActivityFeed, WaiverPriorityList, PicksBankList } from '@/components/league/LeagueSections'

type Tab = 'standings' | 'activity' | 'waivers' | 'picks'

// ── Main screen ──────────────────────────────────────────────────

export default function LeagueScreen() {
    const { push } = useRouter()
    const { current, currentLeague, isCommissioner, loading: currentLeagueLoading } = useLeagueContext()
    const { user } = useAuth()
    const [tab, setTab] = useState<Tab>('standings')
    const [draftLoading, setDraftLoading] = useState(false)

    const { data, loading } = useFocusAsyncData(async () => {
        if (!current || !currentLeague) return null
        const lid = currentLeague.id
        const [standingsData, waiverData, txData, picksData] = await Promise.all([
            getLeagueStandings(lid),
            getWaiverPriorityOrder(lid),
            getLeagueTransactions(lid),
            getAllLeaguePicks(lid),
        ])
        return {
            standings: standingsData,
            waiverOrder: waiverData,
            transactions: txData,
            currentLeaguePicks: picksData,
        }
    }, [current])

    const standings = data?.standings ?? []
    const waiverOrder = data?.waiverOrder ?? []
    const transactions = data?.transactions ?? []
    const currentLeaguePicks = data?.currentLeaguePicks ?? []

    async function handleStartDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await startDraft(currentLeague.id)
            push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinDraftRoom() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveDraft(currentLeague.id)
            if (!draft) {
                Alert.alert('No active draft found')
                return
            }
            if (draft.draftType === 'snake') {
                push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
            } else {
                push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
            }
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleStartRookieDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const result = await startRookieDraft(currentLeague.id)
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: result.draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start rookie draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleReseedRookiePicks() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) { Alert.alert('No active rookie draft found'); return }
            await reseedRookieDraftPicks(draft.id)
            Alert.alert('Done', 'Pick slots updated to reflect traded picks.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinRookieDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) {
                Alert.alert('No active rookie draft found')
                return
            }
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function shareInviteCode() {
        await Share.share({
            message: `Join my Pancake currentLeague! Use invite code: ${currentLeague?.invite_code}`,
        })
    }

    if (currentLeagueLoading || (!current && loading)) {
        return <LoadingScreen />
    }

    if (!current) {
        return <EmptyState message="Join or create a currentLeague first." />
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <View style={styles.headerInfo}>
                        <Text style={styles.currentLeagueName}>{currentLeague?.name}</Text>
                        <Text style={styles.teamName}>{current.team_name}</Text>
                    </View>
                    <View style={styles.headerButtons}>
                        <Pressable
                            style={styles.settingsButton}
                            onPress={() => push('/(modals)/bracket')}
                        >
                            <Text style={styles.settingsButtonText}>Bracket</Text>
                        </Pressable>
{isCommissioner ? (
                            <Pressable
                                style={styles.settingsButton}
                                onPress={() => push('/(modals)/commissioner-settings')}
                            >
                                <Text style={styles.settingsButtonText}>Settings</Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>

                {/* Invite code */}
                <Pressable
                    style={styles.inviteRow}
                    onPress={shareInviteCode}
                >
                    <Text style={styles.inviteLabel}>Invite Code</Text>
                    <Text style={styles.inviteCode}>{currentLeague?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </Pressable>

                {/* Draft actions */}
                {currentLeague?.status === 'setup' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Auction Draft</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'drafting' ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Draft Room</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'drafting' && isCommissioner ? (
                    <Pressable style={[styles.draftButton, { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border, marginTop: 8 }]} onPress={handleReseedRookiePicks} disabled={draftLoading}>
                        <Text style={[styles.draftButtonText, { color: colors.textSecondary }]}>Fix Traded Pick Slots</Text>
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Rookie Draft</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && !isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Rookie Draft</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Tab switcher */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabRow}
                contentContainerStyle={styles.tabRowContent}
            >
                {(['standings', 'activity', 'waivers', 'picks'] as Tab[]).map((t) => (
                    <Pressable
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => setTab(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'standings' ? 'Standings'
                                : t === 'activity' ? 'Activity'
                                : t === 'waivers' ? 'Waivers'
                                : 'Picks'}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>

            {loading ? (
                <ActivityIndicator style={styles.loadingMargin} color={colors.primary} />
            ) : tab === 'standings' ? (
                <StandingsTable
                    standings={standings}
                    myMemberId={current?.id}
                    onSelectTeam={(memberId, teamName) =>
                        push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } })
                    }
                />
            ) : tab === 'activity' ? (
                <ActivityFeed transactions={transactions} myMemberId={current?.id} />
            ) : tab === 'waivers' ? (
                <WaiverPriorityList rows={waiverOrder} myMemberId={current?.id} />
            ) : (
                <PicksBankList picks={currentLeaguePicks} myMemberId={current?.id} />
            )}
        </SafeAreaView>
    )
}

// ── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    loadingMargin: { marginTop: spacing['3xl'] },

    header: { padding: spacing['2xl'], borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: spacing.lg },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    headerInfo: { flex: 1, gap: spacing.xxs },
    currentLeagueName: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold },
    teamName: { fontSize: fontSize.md, color: colors.textMuted },

    headerButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
    settingsButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
    },
    settingsButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: palette.gray100,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: spacing.lg,
    },
    inviteLabel: { fontSize: fontSize.sm, color: colors.textMuted, flex: 1 },
    inviteCode: { fontSize: 15, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 2 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },

    tabRow: {
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        flexGrow: 0,
        flexShrink: 0,
    },
    tabRowContent: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingLeft: spacing['2xl'],
        paddingRight: spacing['4xl'],
        paddingVertical: spacing.lg,
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },
})
