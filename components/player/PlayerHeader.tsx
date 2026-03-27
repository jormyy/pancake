import {
    View,
    Text,
    Image,
    StyleSheet,
    ActivityIndicator,
    Pressable,
} from 'react-native'
import { useState } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { POSITION_COLORS } from '@/constants/positions'

const INJURY_COLORS: Record<string, string> = {
    Questionable: '#F59E0B',
    Doubtful: '#F97316',
    Out: '#EF4444',
    IR: '#7F1D1D',
}

function getInitials(name: string): string {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}

type Player = {
    display_name: string
    nba_team: string | null
    position: string | null
    jersey_number: string | null
    injury_status: string | null
    dynasty_rank: number | null
    headshot_url: string | null
}

type Props = {
    player: Player
    rosterStatus: PlayerRosterStatus | null
    leagueActive: boolean
    actionLoading: boolean
    onAdd: () => void
    onDrop: () => void
    onClaim: () => void
}

export function PlayerHeader({
    player,
    rosterStatus,
    leagueActive,
    actionLoading,
    onAdd,
    onDrop,
    onClaim,
}: Props) {
    const [headshotError, setHeadshotError] = useState(false)
    const posColor = POSITION_COLORS[player.position ?? ''] ?? '#888'

    const metaParts = [
        player.jersey_number ? `#${player.jersey_number}` : null,
        player.nba_team,
        player.position,
    ].filter(Boolean)

    return (
        <View style={styles.header}>
            {/* Avatar */}
            <View style={styles.avatarWrap}>
                {player.headshot_url && !headshotError ? (
                    <Image
                        source={{ uri: player.headshot_url }}
                        style={styles.headshot}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <View style={[styles.initialsCircle, { backgroundColor: posColor }]}>
                        <Text style={styles.initialsText}>
                            {getInitials(player.display_name)}
                        </Text>
                    </View>
                )}
            </View>

            {/* Info */}
            <View style={styles.info}>
                <Text style={styles.name}>{player.display_name}</Text>
                <Text style={styles.meta}>{metaParts.join(' · ')}</Text>
                <View style={styles.badges}>
                    {player.injury_status && (
                        <View
                            style={[
                                styles.badge,
                                {
                                    backgroundColor:
                                        INJURY_COLORS[player.injury_status] ?? '#888',
                                },
                            ]}
                        >
                            <Text style={styles.badgeTextWhite}>
                                {player.injury_status}
                            </Text>
                        </View>
                    )}
                    {player.dynasty_rank != null && (
                        <View style={styles.dynastyBadge}>
                            <Text style={styles.dynastyText}>
                                Dynasty #{player.dynasty_rank}
                            </Text>
                        </View>
                    )}
                </View>
            </View>

            {/* Roster action */}
            {leagueActive && rosterStatus && (
                <View style={styles.actionWrap}>
                    {rosterStatus.status === 'free_agent' ? (
                        <Pressable
                            style={styles.addButton}
                            onPress={onAdd}
                            disabled={actionLoading}
                        >
                            {actionLoading ? (
                                <ActivityIndicator size="small" color="#fff" />
                            ) : (
                                <Text style={styles.addButtonText}>+ Add</Text>
                            )}
                        </Pressable>
                    ) : rosterStatus.status === 'on_waivers' ? (
                        <Pressable
                            style={styles.claimButton}
                            onPress={onClaim}
                            disabled={actionLoading}
                        >
                            <Text style={styles.claimButtonText}>Claim</Text>
                        </Pressable>
                    ) : rosterStatus.status === 'mine' ? (
                        <Pressable
                            style={styles.dropButton}
                            onPress={onDrop}
                            disabled={actionLoading}
                        >
                            {actionLoading ? (
                                <ActivityIndicator size="small" color="#EF4444" />
                            ) : (
                                <Text style={styles.dropButtonText}>Drop</Text>
                            )}
                        </Pressable>
                    ) : (
                        <View style={styles.takenBadge}>
                            <Text style={styles.takenText}>
                                {rosterStatus.ownerTeamName}
                            </Text>
                        </View>
                    )}
                </View>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
    avatarWrap: { flexShrink: 0 },
    headshot: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#f3f3f3' },
    initialsCircle: {
        width: 72,
        height: 72,
        borderRadius: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    initialsText: { color: '#fff', fontSize: 22, fontWeight: '700' },

    info: { flex: 1, gap: 4 },
    name: { fontSize: 22, fontWeight: '800', color: '#111' },
    meta: { fontSize: 14, color: '#888' },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },

    badge: {
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
    },
    badgeTextWhite: { color: '#fff', fontSize: 11, fontWeight: '700' },

    dynastyBadge: {
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f3f3f3',
    },
    dynastyText: { color: '#555', fontSize: 11, fontWeight: '600' },

    actionWrap: { flexShrink: 0 },

    addButton: {
        backgroundColor: '#F97316',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        minWidth: 68,
        alignItems: 'center',
    },
    addButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    dropButton: {
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: '#EF4444',
        minWidth: 68,
        alignItems: 'center',
    },
    dropButtonText: { color: '#EF4444', fontWeight: '700', fontSize: 14 },

    claimButton: {
        backgroundColor: '#8B5CF6',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        minWidth: 68,
        alignItems: 'center',
    },
    claimButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    takenBadge: {
        backgroundColor: '#f3f3f3',
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
    },
    takenText: { color: '#888', fontSize: 12, fontWeight: '600' },
})
