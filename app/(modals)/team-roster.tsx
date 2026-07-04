import {
    View,
    Text,
    Pressable,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { isTradingClosed } from '@/lib/league'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { getPositionColor } from "@/constants/positions"
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { EmptyState } from '@/components/EmptyState'
import { ItemSeparator } from '@/components/ItemSeparator'
import { PosTag } from '@/components/PosTag'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import { playerHeadshotUrl } from '@/lib/format'

export default function TeamRosterScreen() {
    const { back, push } = useRouter()
    const { memberId, teamName } = useLocalSearchParams<{ memberId: string; teamName: string }>()
    const { current, currentLeague } = useLeagueContext()
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const canProposeTrade = !!memberId && memberId !== current?.id && !isTradingClosed(currentLeague)

    useEffect(() => {
        if (!memberId || !current || !currentLeague) return
        setRoster([])
        getRoster(memberId, currentLeague.id)
            .then(setRoster)
            .catch(console.error)
    }, [memberId, current, currentLeague])

    const active = roster.filter((r) => !r.is_on_ir && !r.is_on_taxi)
    const ir = roster.filter((r) => r.is_on_ir)
    const taxi = roster.filter((r) => r.is_on_taxi)
    const rows = [...active, ...ir, ...taxi]

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <View style={styles.headerInner}>
                    <Pressable
                        onPress={() => back()}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel="Close team roster"
                    >
                        <Text style={styles.closeText}>Done</Text>
                    </Pressable>
                    <Text style={styles.headerTitle} numberOfLines={1}>{teamName ?? 'Roster'}</Text>
                    {canProposeTrade ? (
                        <Pressable
                            onPress={() => push({ pathname: '/(modals)/propose-trade', params: { recipientMemberId: memberId } })}
                            style={styles.closeButton}
                            accessibilityRole="button"
                            accessibilityLabel={`Propose trade with ${teamName ?? 'this team'}`}
                        >
                            <Text style={styles.closeText}>Trade</Text>
                        </Pressable>
                    ) : (
                        <View style={styles.closeButton} />
                    )}
                </View>
            </View>

            <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
            >
                {roster.length === 0 ? (
                    <EmptyState
                        icon="sports-basketball"
                        message="No players yet"
                        description="This team's roster fills as the draft and season unfold. Check back once the draft is underway."
                        fullScreen={false}
                        framed
                    />
                ) : (
                    <>
                        <View style={styles.countRow}>
                            <Text style={styles.countText}>
                                {active.length} active
                                {ir.length > 0 ? ` · ${ir.length} IR` : ''}
                                {taxi.length > 0 ? ` · ${taxi.length} Taxi` : ''}
                            </Text>
                        </View>

                        {rows.map((item, index) => {
                            const p = item.players
                            const eligiblePositions = getEligiblePositions(p)
                            return (
                                <View key={item.id}>
                                    {index > 0 ? <ItemSeparator /> : null}
                                    <Pressable
                                        style={styles.playerRow}
                                        onPress={() => push({ pathname: '/player/[id]', params: { id: p.id } })}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Open ${p.display_name}`}
                                    >
                                        <Avatar
                                            name={p.display_name}
                                            color={getPositionColor(eligiblePositions[0])}
                                            size={44}
                                            uri={playerHeadshotUrl(p.nba_id)}
                                        />
                                        <View style={styles.playerInfo}>
                                            <Text style={styles.playerName}>{p.display_name}</Text>
                                            <View style={styles.playerMetaRow}>
                                                {p.nba_team && <Text style={styles.playerMeta}>{p.nba_team}</Text>}
                                                {eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                            </View>
                                        </View>
                                        <View style={styles.badges}>
                                            {p.injury_status ? (
                                                <Badge
                                                    label={p.injury_status}
                                                    color={colors.danger}
                                                    variant="soft"
                                                />
                                            ) : null}
                                            {item.is_on_ir ? (
                                                <Badge label="IR" color={colors.textMuted} variant="soft" />
                                            ) : null}
                                            {item.is_on_taxi ? (
                                                <Badge label="TX" color={colors.textMuted} variant="soft" />
                                            ) : null}
                                        </View>
                                    </Pressable>
                                </View>
                            )
                        })}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    header: {
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    // Header actions align with the centered roster column below instead of
    // pinning to the far edges of a wide canvas.
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 680,
        alignSelf: 'center',
    },
    closeButton: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    closeText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    headerTitle: { flex: 1, fontSize: 18, fontWeight: fontWeight.extrabold, textAlign: 'center' },

    list: { flex: 1 },
    listContent: { width: '100%', maxWidth: 680, alignSelf: 'center' },

    countRow: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    countText: { fontSize: fontSize.sm, color: colors.textMuted },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    playerInfo: { flex: 1, gap: spacing.xxs },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    badges: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
})
