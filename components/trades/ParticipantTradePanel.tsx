import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { orderTradeAssets, tradeRosterAssetOrder } from '@/lib/trade-assets'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { SectionBand } from '@/components/ui/SectionBand'
import { Sheet } from '@/components/ui/Sheet'
import { pickLabel } from '@/lib/picks'
import { yearShort } from '@/lib/format'
import { playerSeasonContextText } from '@/lib/player-context'
import { colors, componentTokens, controlSize, fontWeight, radii, spacing, textStyles, typeScale, uiColors } from '@/constants/tokens'
import { canUpdateTradeFaabInput, MAX_TRADE_FAAB_DIGITS, validateTradeFaabInput } from '@/lib/multi-team-trade-state'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

const SEARCH_THRESHOLD = 8

type RouteTarget = { asset: 'player' | 'pick'; id: string; label: string }

type ParticipantTradePanelProps = {
    participant: TradeParticipantView
    myMemberId: string
    faabEnabled: boolean
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    assetLabels?: ReadonlyMap<string, string>
    participantName: (memberId: string) => string
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onRemoveAsset?: (memberId: string, asset: 'player' | 'pick', assetId: string) => void
    blockedPlayerIds: ReadonlySet<string>
    blockedPickIds: ReadonlySet<string>
    onPlayerDestinationChange: (memberId: string, playerId: string, toMemberId: string) => void
    onPickDestinationChange: (memberId: string, pickId: string, toMemberId: string) => void
    onFaabChange: (memberId: string, toMemberId: string, value: string) => void
}

export function ParticipantTradePanel({
    participant,
    myMemberId,
    faabEnabled,
    avgMap,
    avgStatsMap,
    assetLabels,
    participantName,
    onTogglePlayer,
    onTogglePick,
    onRemoveAsset,
    blockedPlayerIds,
    blockedPickIds,
    onPlayerDestinationChange,
    onPickDestinationChange,
    onFaabChange,
}: ParticipantTradePanelProps) {
    const [adding, setAdding] = useState(false)
    const [query, setQuery] = useState('')
    const [routing, setRouting] = useState<RouteTarget | null>(null)
    const memberId = participant.memberId
    const mine = memberId === myMemberId
    const teamName = participantName(memberId)
    const showRoutes = participant.destinationIds.length > 1
    const remove = (asset: 'player' | 'pick', id: string) => {
        if (onRemoveAsset) onRemoveAsset(memberId, asset, id)
        else if (asset === 'player') onTogglePlayer(memberId, id)
        else onTogglePick(memberId, id)
    }
    const players = orderTradeAssets(participant.roster.filter((row) => participant.selectedPlayerIds.has(row.players.id)), tradeRosterAssetOrder)
    const missingPlayerIds = [...participant.selectedPlayerIds].filter((id) => !participant.roster.some((row) => row.players.id === id))
    const picks = orderTradeAssets(participant.picks.filter((pick) => participant.selectedPickIds.has(pick.pickId)))
    const missingPickIds = [...participant.selectedPickIds].filter((id) => !participant.picks.some((pick) => pick.pickId === id))
    const empty = participant.selectedPlayerIds.size === 0 && participant.selectedPickIds.size === 0
    const search = query.trim().toLowerCase()
    const roster = search
        ? participant.roster.filter((row) => row.players.display_name.toLowerCase().includes(search))
        : participant.roster
    const closeAdding = () => { setAdding(false); setQuery('') }

    const routeChip = (target: RouteTarget, destinationId: string | undefined) => showRoutes ? (
        <Pressable
            style={styles.routeChip}
            onPress={() => setRouting(target)}
            accessibilityRole="button"
            accessibilityLabel={`Choose who receives ${target.label}. Now to ${destinationId ? participantName(destinationId) : 'no team'}`}
            testID={`trade-route-${memberId}-${target.asset}-${target.id}`}
            id={`trade-route-${memberId}-${target.asset}-${target.id}`}
        >
            <View style={styles.routePill}>
                <Text style={styles.routeText} numberOfLines={1}>to {destinationId ? participantName(destinationId) : 'Choose team'}</Text>
                <MaterialIcons name="expand-more" size={controlSize.icon.sm} color={colors.textSecondary} />
            </View>
        </Pressable>
    ) : null

    const removeButton = (asset: 'player' | 'pick', id: string, label: string) => (
        <Pressable
            style={styles.removeButton}
            onPress={() => remove(asset, id)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${label} from trade`}
            testID={`trade-remove-${memberId}-${asset}-${id}`}
            id={`trade-remove-${memberId}-${asset}-${id}`}
        >
            <Text style={styles.removeText} numberOfLines={1}>Remove</Text>
        </Pressable>
    )

    const routeDestinationId = routing
        ? routing.asset === 'player' ? participant.playerDestinationIds[routing.id] : participant.pickDestinationIds[routing.id]
        : undefined

    return (
        <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label={mine ? 'You send' : `${teamName} sends`} />
            {empty ? <Text style={styles.emptyText}>Nothing yet.</Text> : null}
            {players.map((row) => {
                const player = row.players
                return (
                    <View key={`player:${player.id}`} style={styles.assetRow}>
                        <View style={styles.assetLine}>
                            <TradePlayerLink compact playerId={player.id} name={player.display_name} nbaId={player.nba_id} team={player.nba_team}
                                positions={player.eligible_positions ?? []} birthdate={player.birthdate} yearsExp={player.years_exp}
                                careerGames={player.career_regular_season_games} injuryStatus={player.injury_status}
                                stats={<Text style={styles.statText} numberOfLines={1}>{playerSeasonContextText({
                                    yearsExp: player.years_exp,
                                    avgFantasyPoints: avgMap.get(player.id) ?? null,
                                    avgMinutesPlayed: avgStatsMap.get(player.id)?.avg_minutes_played ?? null,
                                })}</Text>} />
                            {removeButton('player', player.id, player.display_name)}
                        </View>
                        {routeChip({ asset: 'player', id: player.id, label: player.display_name }, participant.playerDestinationIds[player.id])}
                    </View>
                )
            })}
            {missingPlayerIds.map((id) => {
                const label = assetLabels?.get(`player:${id}`) ?? 'Player'
                return (
                    <View key={`missing-player:${id}`} style={styles.assetRow}>
                        <View style={styles.assetLine}>
                            <View style={styles.assetCopy}>
                                <Text style={styles.assetName} numberOfLines={1}>{label}</Text>
                                <Text style={styles.unavailable} numberOfLines={1}>Unavailable from this team</Text>
                            </View>
                            {removeButton('player', id, label)}
                        </View>
                    </View>
                )
            })}
            {picks.map((pick) => {
                const label = pickLabel(pick.seasonYear, pick.round)
                return (
                    <View key={`pick:${pick.pickId}`} style={styles.assetRow}>
                        <View style={styles.assetLine}>
                            <View style={styles.pickCircle}>
                                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
                            </View>
                            <View style={styles.assetCopy}>
                                <Text style={styles.assetName} numberOfLines={1}>{label}</Text>
                                <Text style={styles.assetMeta} numberOfLines={1}>via {pick.originalTeamName}</Text>
                            </View>
                            {removeButton('pick', pick.pickId, `${label} pick via ${pick.originalTeamName}`)}
                        </View>
                        {routeChip({ asset: 'pick', id: pick.pickId, label: `${label} pick` }, participant.pickDestinationIds[pick.pickId])}
                    </View>
                )
            })}
            {missingPickIds.map((id) => {
                const label = assetLabels?.get(`pick:${id}`) ?? 'Draft pick'
                return (
                    <View key={`missing-pick:${id}`} style={styles.assetRow}>
                        <View style={styles.assetLine}>
                            <View style={styles.assetCopy}>
                                <Text style={styles.assetName} numberOfLines={1}>{label}</Text>
                                <Text style={styles.unavailable} numberOfLines={1}>Unavailable from this team</Text>
                            </View>
                            {removeButton('pick', id, label)}
                        </View>
                    </View>
                )
            })}
            {faabEnabled ? participant.destinationIds.map((destinationId) => {
                const value = participant.faabInputs[destinationId] ?? '0'
                const error = validateTradeFaabInput(value).error
                return (
                    <View key={`faab:${destinationId}`} style={styles.assetRow}>
                        <View style={styles.assetLine}>
                            <Text style={styles.faabLabel} numberOfLines={1}>FAAB to {participantName(destinationId)}</Text>
                            <TextInput
                                style={[styles.faabInput, error && styles.faabInputInvalid]}
                                value={value}
                                onChangeText={(nextValue) => {
                                    if (canUpdateTradeFaabInput(value, nextValue)) onFaabChange(memberId, destinationId, nextValue)
                                }}
                                maxLength={Math.max(MAX_TRADE_FAAB_DIGITS, value.length)}
                                keyboardType="numeric"
                                accessibilityLabel={error
                                    ? `FAAB sent by ${teamName} to ${participantName(destinationId)}. ${error}`
                                    : `FAAB sent by ${teamName} to ${participantName(destinationId)}`}
                                aria-invalid={Boolean(error)}
                                testID={`trade-faab-${memberId}-${destinationId}`}
                                id={`trade-faab-${memberId}-${destinationId}`}
                            />
                        </View>
                        {error ? (
                            <Text style={styles.faabError} accessibilityRole="alert" accessibilityLiveRegion="polite"
                                testID={`trade-faab-error-${memberId}-${destinationId}`}>
                                {error}
                            </Text>
                        ) : null}
                    </View>
                )
            }) : null}
            <Pressable
                style={styles.addRow}
                onPress={() => setAdding(true)}
                accessibilityRole="button"
                accessibilityLabel={`Add players or picks from ${mine ? 'your team' : teamName}`}
                testID={`trade-add-assets-${memberId}`}
                id={`trade-add-assets-${memberId}`}
            >
                <MaterialIcons name="add" size={controlSize.icon.md} color={colors.primaryDark} />
                <Text style={styles.addText} numberOfLines={1}>Add players or picks</Text>
            </Pressable>

            <Sheet visible={adding} title={mine ? 'Your players and picks' : `${teamName} players and picks`} onClose={closeAdding}>
                {adding ? (
                    <View style={styles.sheetBody}>
                        {participant.roster.length > SEARCH_THRESHOLD ? (
                            <Input value={query} onChangeText={setQuery} placeholder="Search players" leftIcon="search"
                                accessibilityLabel={`Search ${mine ? 'your' : teamName} players`} autoCorrect={false} />
                        ) : null}
                        <TradeAssetColumn
                            memberId={memberId}
                            roster={roster}
                            picks={search ? [] : participant.picks}
                            avgMap={avgMap}
                            avgStatsMap={avgStatsMap}
                            selectedPlayerIds={participant.selectedPlayerIds}
                            selectedPickIds={participant.selectedPickIds}
                            blockedPlayerIds={blockedPlayerIds}
                            blockedPickIds={blockedPickIds}
                            onTogglePlayer={(playerId) => onTogglePlayer(memberId, playerId)}
                            onTogglePick={(pickId) => onTogglePick(memberId, pickId)}
                            emptyText={search ? 'No matching players.' : 'No tradeable active players.'}
                            testIdPrefix={`trade-${memberId}`}
                        />
                    </View>
                ) : null}
            </Sheet>

            <Sheet visible={routing !== null} title={routing ? `Send ${routing.label} to` : undefined} onClose={() => setRouting(null)}>
                {routing ? participant.destinationIds.map((destinationId) => {
                    const active = destinationId === routeDestinationId
                    const testID = `trade-${routing.asset}-route-${memberId}-${routing.id}-${destinationId}`
                    return (
                        <Pressable
                            key={destinationId}
                            style={styles.sheetOption}
                            onPress={() => {
                                if (routing.asset === 'player') onPlayerDestinationChange(memberId, routing.id, destinationId)
                                else onPickDestinationChange(memberId, routing.id, destinationId)
                                setRouting(null)
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Route ${routing.label} to ${participantName(destinationId)}`}
                            accessibilityState={{ selected: active }}
                            testID={testID}
                            id={testID}
                        >
                            <Text style={[styles.sheetOptionText, active && styles.sheetOptionTextActive]} numberOfLines={1}>
                                {participantName(destinationId)}
                            </Text>
                            {active ? <MaterialIcons name="check" size={controlSize.icon.md} color={colors.primaryDark} /> : null}
                        </Pressable>
                    )
                }) : null}
            </Sheet>
        </Card>
    )
}

const rowPadX = componentTokens.sectionBand.paddingHorizontal

const styles = StyleSheet.create({
    card: { overflow: 'hidden' },
    emptyText: { ...textStyles.meta, paddingHorizontal: rowPadX, paddingVertical: spacing.md, color: colors.textPlaceholder },
    assetRow: {
        paddingHorizontal: rowPadX,
        paddingVertical: componentTokens.playerRow.compact.paddingVertical,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    assetLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: componentTokens.playerRow.compact.gap,
        minHeight: componentTokens.playerRow.compact.minHeight,
        minWidth: 0,
    },
    assetCopy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    assetName: { ...textStyles.rowTitle, flexShrink: 1, minWidth: 0 },
    assetMeta: { ...textStyles.meta },
    unavailable: { ...typeScale.caption, color: colors.warningDark, fontWeight: fontWeight.semibold },
    statText: { ...typeScale.caption, color: colors.primaryDark, fontWeight: fontWeight.semibold },
    pickCircle: {
        flexShrink: 0,
        width: controlSize.avatar.sm,
        height: controlSize.avatar.sm,
        borderRadius: radii.full,
        backgroundColor: colors.info,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickCircleText: { ...typeScale.small, color: colors.onAccent, fontWeight: fontWeight.bold },
    removeButton: {
        flexShrink: 0,
        width: controlSize.minTouch + spacing['3xl'],
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
    },
    removeText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    routeChip: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
        minHeight: controlSize.minTouch,
        justifyContent: 'center',
        marginLeft: componentTokens.playerRow.compact.avatarSize + componentTokens.playerRow.compact.gap,
    },
    routePill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xxs,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xxs,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
    },
    routeText: { ...typeScale.caption, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    faabLabel: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    faabInput: {
        ...typeScale.title,
        flexShrink: 0,
        width: controlSize.minTouch + spacing['6xl'],
        minHeight: controlSize.minTouch,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'right',
    },
    faabInputInvalid: { borderColor: colors.danger },
    faabError: { ...typeScale.small, color: colors.dangerDark, fontWeight: fontWeight.semibold, paddingBottom: spacing.xs },
    addRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: controlSize.minTouch,
        paddingHorizontal: rowPadX,
        paddingVertical: spacing.xs,
    },
    addText: { ...typeScale.row, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    sheetBody: { gap: spacing.md },
    sheetOption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    sheetOptionText: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    sheetOptionTextActive: { color: colors.primaryDark },
})
