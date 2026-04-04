import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { POSITION_COLORS } from '@/constants/positions'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { ItemSeparator } from '@/components/ItemSeparator'
import { PosTag } from '@/components/PosTag'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export default function TeamRosterScreen() {
    const { back, push } = useRouter()
    const { memberId, teamName } = useLocalSearchParams<{ memberId: string; teamName: string }>()
    const { current } = useLeagueContext()
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        if (!memberId || !current) return
        const leagueId = (current.leagues as any).id
        setLoading(true)
        getRoster(memberId, leagueId)
            .then(setRoster)
            .catch(console.error)
            .finally(() => setLoading(false))
    }, [memberId, current])

    const active = roster.filter((r) => !r.is_on_ir)
    const ir = roster.filter((r) => r.is_on_ir)

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <View style={styles.header}>
                <Pressable onPress={() => back()} style={styles.closeButton}>
                    <Text style={styles.closeText}>Done</Text>
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>{teamName ?? 'Roster'}</Text>
                <View style={styles.closeButton} />
            </View>

            {loading ? (
                <ActivityIndicator style={styles.loading} color={colors.primary} />
            ) : (
                <FlashList
                    data={[...active, ...ir]}
                    keyExtractor={(r) => r.id}
                    ItemSeparatorComponent={ItemSeparator}
                    estimatedItemSize={64}
                    ListHeaderComponent={
                        <View style={styles.countRow}>
                            <Text style={styles.countText}>{active.length} active{ir.length > 0 ? ` · ${ir.length} IR` : ''}</Text>
                        </View>
                    }
                    renderItem={({ item }) => {
                        const p = item.players
                        const eligiblePositions: string[] = p.eligible_positions?.length ? p.eligible_positions : (p.position ? [p.position] : [])
                        return (
                            <Pressable
                                style={styles.playerRow}
                                onPress={() => push({ pathname: '/player/[id]', params: { id: p.id } })}
                            >
                                <Avatar
                                    name={p.display_name}
                                    color={POSITION_COLORS[eligiblePositions[0] ?? ''] ?? palette.gray500}
                                    size={44}
                                    uri={p.nba_id ? `https://cdn.nba.com/headshots/nba/latest/260x190/${p.nba_id}.png` : null}
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
                                            color={colors.error}
                                            variant="soft"
                                        />
                                    ) : null}
                                    {item.is_on_ir ? (
                                        <Badge label="IR" color={palette.gray500} variant="soft" />
                                    ) : null}
                                </View>
                            </Pressable>
                        )
                    }}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    closeButton: { minWidth: 48 },
    closeText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.primary },
    headerTitle: { flex: 1, fontSize: 18, fontWeight: fontWeight.extrabold, textAlign: 'center' },

    loading: { marginTop: 40 },

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
