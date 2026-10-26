import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from './PlayerAvatar'
import { PlayerEligibilityTags } from './PlayerEligibilityTags'
import { Avatar } from '@/components/Avatar'
import { PosTag } from '@/components/PosTag'

export type PlayerRowContentProps = {
    name: string
    nbaId?: string | null
    headshotUrl?: string | null
    team?: string | null
    positions?: readonly string[]
    yearsExp?: number | null
    careerGames?: number | null
    injuryStatus?: string | null
    stats?: ReactNode
    metadata?: ReactNode
    live?: boolean
}

export function PlayerRowContent({ name, nbaId, headshotUrl, team, positions = [], yearsExp, careerGames, injuryStatus, stats, metadata, live = false }: PlayerRowContentProps) {
    return <View style={styles.row} testID="player-row-content">
        <View testID="player-row-avatar">{headshotUrl ? <Avatar name={name} uri={headshotUrl} size={36} /> : <PlayerAvatar name={name} nbaId={nbaId} size={36} />}</View>
        <View style={styles.copy}>
            <Text style={styles.name} numberOfLines={1} testID="player-name-line">{name}</Text>
            <View style={styles.metadata} testID="player-meta-line">
                {team ? <Text style={styles.team} numberOfLines={1}>{team}</Text> : null}
                {positions.map(position => <PosTag key={position} position={position} />)}
                <PlayerEligibilityTags yearsExp={yearsExp} careerGames={careerGames} injuryStatus={injuryStatus} />
                {metadata}
            </View>
            <View style={styles.stats} testID="player-stats-line">
                {typeof stats === 'string' || typeof stats === 'number' ? <Text style={[styles.statText, live && styles.live]} numberOfLines={1}>{stats}</Text> : stats}
            </View>
        </View>
    </View>
}

const styles = StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    copy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    name: { ...textStyles.rowTitle, minWidth: 0 },
    metadata: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 18, minWidth: 0 },
    team: { ...textStyles.meta, flexShrink: 1 },
    stats: { minHeight: textStyles.meta.lineHeight, minWidth: 0 },
    statText: { ...textStyles.meta, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    live: { color: colors.success },
})
