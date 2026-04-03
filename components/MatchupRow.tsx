import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { LineupPlayer } from '@/lib/lineup'
import { LiveStatLine } from '@/lib/games'
import { computeLiveFantasyPoints } from '@/lib/scoring'
import { POSITION_COLORS } from '@/constants/positions'
import { colors, palette, fontWeight } from '@/constants/tokens'
import { PosTag } from '@/components/PosTag'
import { InjuryBadge } from '@/components/InjuryBadge'

type Sel = { kind: 'starter' | 'bench' | 'ir'; index: number }

const SLOT_W = 52

function shortName(name: string): string {
    const parts = name.trim().split(' ')
    if (parts.length <= 1) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function StatLines({ stats, isLive, align }: {
    stats: LiveStatLine
    isLive: boolean
    align: 'left' | 'right'
}) {
    const base = [styles.statLine, isLive ? styles.statLineLive : null, { textAlign: align }]
    if (stats.didNotPlay) return <Text style={base}>DNP</Text>
    const to = stats.turnovers ?? 0
    const line1 = [
        stats.points   ? `${stats.points} PTS`   : null,
        stats.rebounds ? `${stats.rebounds} REB`  : null,
        stats.assists  ? `${stats.assists} AST`   : null,
        stats.steals   ? `${stats.steals} STL`    : null,
        stats.blocks   ? `${stats.blocks} BLK`    : null,
    ].filter(Boolean).join(', ') || '—'
    const line2 = [
        stats.fgAttempted ? `${stats.fgMade}/${stats.fgAttempted} FGM` : null,
        stats.ftAttempted ? `${stats.ftMade}/${stats.ftAttempted} FTM` : null,
        stats.threeMade   ? `${stats.threeMade} 3PM`                   : null,
        to                ? `${to} TO`                                  : null,
        stats.fouls       ? `${stats.fouls} PF`                        : null,
    ].filter(Boolean).join(', ')
    return (
        <>
            <Text style={base} numberOfLines={1}>{line1}</Text>
            {line2 ? <Text style={base} numberOfLines={1}>{line2}</Text> : null}
        </>
    )
}

export function MatchupRow({
    myPlayer,
    oppPlayer,
    slotType,
    selKind,
    selIndex,
    selected,
    onTap,
    saving,
    playingTeams,
    liveStats,
    liveTeams,
    scoringSettings,
    teamMatchups,
    isExtraOppRow = false,
}: {
    myPlayer: LineupPlayer | null
    oppPlayer: LineupPlayer | null
    slotType: string
    selKind: 'starter' | 'bench' | 'ir'
    selIndex: number
    selected: Sel | null
    onTap: (sel: Sel) => void
    saving: boolean
    playingTeams: Set<string>
    liveStats: Map<string, LiveStatLine>
    liveTeams: Set<string>
    scoringSettings: Record<string, number>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    isExtraOppRow?: boolean
}) {
    const { push } = useRouter()
    const isSel = selected?.kind === selKind && selected.index === selIndex
    const slotColor = slotType === 'IR' ? colors.danger : (POSITION_COLORS[slotType] ?? colors.textPlaceholder)
    const myHasGame = myPlayer?.nbaTeam ? playingTeams.has(myPlayer.nbaTeam) : false
    const oppHasGame = oppPlayer?.nbaTeam ? playingTeams.has(oppPlayer.nbaTeam) : false
    const myMatchup = myPlayer?.nbaTeam ? teamMatchups.get(myPlayer.nbaTeam) : undefined
    const oppMatchup = oppPlayer?.nbaTeam ? teamMatchups.get(oppPlayer.nbaTeam) : undefined
    const myMatchupLabel = myPlayer?.nbaTeam
        ? (myMatchup ? `${myMatchup.isHome ? 'vs' : '@'} ${myMatchup.opponent}` : 'No game')
        : null
    const oppMatchupLabel = oppPlayer?.nbaTeam
        ? (oppMatchup ? `${oppMatchup.isHome ? 'vs' : '@'} ${oppMatchup.opponent}` : 'No game')
        : null
    const myStats = myPlayer ? liveStats.get(myPlayer.playerId) : undefined
    const oppStats = oppPlayer ? liveStats.get(oppPlayer.playerId) : undefined
    const myIsLive = myPlayer?.nbaTeam ? liveTeams.has(myPlayer.nbaTeam) : false
    const oppIsLive = oppPlayer?.nbaTeam ? liveTeams.has(oppPlayer.nbaTeam) : false
    const myFpts = myStats && !myStats.didNotPlay ? computeLiveFantasyPoints(myStats, scoringSettings) : null
    const oppFpts = oppStats && !oppStats.didNotPlay ? computeLiveFantasyPoints(oppStats, scoringSettings) : null
    const myPlayedToday = myStats != null && !myStats.didNotPlay
    const oppPlayedToday = oppStats != null && !oppStats.didNotPlay
    const myShowInjury = myPlayer?.injuryStatus && !myPlayedToday
    const oppShowInjury = oppPlayer?.injuryStatus && !oppPlayedToday

    return (
        <View style={[styles.matchupRow, isExtraOppRow && styles.extraOppRow]}>
            {/* Left: my player (right-aligned) */}
            <Pressable
                style={styles.rowSideLeft}
                onPress={myPlayer ? () => push(`/player/${myPlayer.playerId}` as any) : undefined}
                disabled={!myPlayer}
            >
                {myPlayer ? (
                    <>
                        {myFpts != null && (
                            <Text style={[styles.fptsNum, myIsLive && styles.fptsLive]}>{myFpts}</Text>
                        )}
                        <View style={styles.playerBlockRight}>
                            <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                                {myShowInjury && <InjuryBadge status={myPlayer.injuryStatus} />}
                                <Text style={[styles.sideName, !myHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(myPlayer.displayName)}
                                </Text>
                            </View>
                            <View style={[styles.metaRow, { justifyContent: 'flex-end' }]}>
                                {myIsLive && <Text style={styles.lockedBadge}>LIVE</Text>}
                                {myPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                {myMatchupLabel !== null && (
                                    <Text style={styles.sideMeta} numberOfLines={1}>
                                        {myPlayer.nbaTeam} · {myMatchupLabel}
                                    </Text>
                                )}
                            </View>
                            {myStats ? (
                                <StatLines stats={myStats} isLive={myIsLive} align="right" />
                            ) : null}
                        </View>
                    </>
                ) : isExtraOppRow ? null : (
                    <Text style={[styles.sideName, { color: colors.border, textAlign: 'right' }]}>—</Text>
                )}
            </Pressable>

            {/* Center: slot chip */}
            <Pressable
                style={[
                    styles.slotChipCenter,
                    { backgroundColor: isExtraOppRow ? colors.separator : slotColor + '22' },
                    isSel && styles.slotChipSelected,
                ]}
                onPress={isExtraOppRow ? undefined : () => onTap({ kind: selKind, index: selIndex })}
                disabled={saving || isExtraOppRow}
            >
                <Text style={[styles.slotChipText, { color: isExtraOppRow ? colors.textPlaceholder : (isSel ? colors.primary : slotColor) }]}>
                    {isExtraOppRow ? '—' : slotType}
                </Text>
            </Pressable>

            {/* Right: opponent player (left-aligned) */}
            <Pressable
                style={styles.rowSideRight}
                onPress={oppPlayer ? () => push(`/player/${oppPlayer.playerId}` as any) : undefined}
                disabled={!oppPlayer}
            >
                {oppPlayer ? (
                    <>
                        <View style={styles.playerBlockLeft}>
                            <View style={styles.metaRow}>
                                <Text style={[styles.sideName, !oppHasGame && styles.noGameName]} numberOfLines={1}>
                                    {shortName(oppPlayer.displayName)}
                                </Text>
                                {oppShowInjury && <InjuryBadge status={oppPlayer.injuryStatus} />}
                            </View>
                            <View style={styles.metaRow}>
                                {oppPlayer.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                                {oppMatchupLabel !== null && (
                                    <Text style={styles.sideMeta} numberOfLines={1}>
                                        {oppPlayer.nbaTeam} · {oppMatchupLabel}
                                    </Text>
                                )}
                                {oppIsLive && <Text style={styles.lockedBadge}>LIVE</Text>}
                            </View>
                            {oppStats ? (
                                <StatLines stats={oppStats} isLive={oppIsLive} align="left" />
                            ) : null}
                        </View>
                        {oppFpts != null && (
                            <Text style={[styles.fptsNum, styles.fptsRight, oppIsLive && styles.fptsLive]}>{oppFpts}</Text>
                        )}
                    </>
                ) : (
                    <Text style={[styles.sideName, { color: colors.border }]}>—</Text>
                )}
            </Pressable>
        </View>
    )
}

const styles = StyleSheet.create({
    matchupRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: 8,
    },
    extraOppRow: {
        opacity: 0.55,
    },
    rowSideLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    rowSideRight: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    playerBlockRight: { flex: 1, alignItems: 'flex-end' },
    playerBlockLeft: { flex: 1, alignItems: 'flex-start' },
    fptsNum: { fontSize: 20, fontWeight: '800', color: colors.textMuted, minWidth: 36, textAlign: 'left', marginRight: 6 },
    fptsRight: { textAlign: 'right', marginRight: 0, marginLeft: 6 },
    fptsLive: { color: colors.primary },
    sideName: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
    noGameName: { color: palette.gray500 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    sideMeta: { fontSize: 11, color: colors.textPlaceholder },
    lockedBadge: { fontSize: 10, fontWeight: fontWeight.bold, color: '#16a34a', letterSpacing: 0.4, marginHorizontal: 3 },
    statLine: { fontSize: 11, color: colors.textMuted, textAlign: 'right', marginTop: 1 },
    statLineLive: { color: colors.primary, fontWeight: fontWeight.semibold },
    slotChipCenter: {
        width: SLOT_W,
        height: 30,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    slotChipSelected: { borderWidth: 1.5, borderColor: colors.primary },
    slotChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
})
