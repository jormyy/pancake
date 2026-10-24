import { View, Text, StyleSheet } from 'react-native'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RosterPlayer } from '@/lib/roster'
import { orderRosterOptions } from '@/lib/player-roster-options'
import { colors, fontWeight, spacing, table, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from '@/components/player/PlayerAvatar'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

type Phase = 'ineligible' | 'drop-to-activate'

type Props = {
    visible: boolean
    ineligibleIR: RosterPlayer[]
    activeRoster: RosterPlayer[]
    rosterSize: number
    pendingPlayerName: string
    onActivate: (player: RosterPlayer) => Promise<void>
    onDropAndActivate: (dropPlayer: RosterPlayer, activatePlayer: RosterPlayer) => Promise<void>
    onCancel: () => void
}

function PlayerLine({ player, action }: { player: RosterPlayer; action: ReactNode }) {
    const p = player.players
    return (
        <View style={styles.row}>
            <PlayerAvatar
                name={p.display_name}
                nbaId={p.nba_id}
                color={colors.bgMuted}
                size={spacing['4xl'] + spacing.xs}
            />
            <View style={styles.info}>
                <Text style={textStyles.rowTitle} numberOfLines={1}>{p.display_name}</Text>
                <Text style={textStyles.meta}>{[p.nba_team, p.position].filter(Boolean).join(' · ')}</Text>
            </View>
            {action}
        </View>
    )
}

export function IRResolutionModal({
    visible,
    ineligibleIR,
    activeRoster,
    rosterSize,
    pendingPlayerName,
    onActivate,
    onDropAndActivate,
    onCancel,
}: Props) {
    const [phase, setPhase] = useState<Phase>('ineligible')
    const [activatingPlayer, setActivatingPlayer] = useState<RosterPlayer | null>(null)
    const [loadingId, setLoadingId] = useState<string | null>(null)
    const irOptions = useMemo(() => orderRosterOptions(ineligibleIR), [ineligibleIR])
    const dropOptions = useMemo(() => orderRosterOptions(activeRoster), [activeRoster])

    const activeCount = activeRoster.length
    const hasRoom = activeCount < rosterSize

    function reset() {
        setPhase('ineligible')
        setActivatingPlayer(null)
        setLoadingId(null)
    }

    // Start from the first step every time the sheet opens.
    useEffect(() => {
        if (visible) reset()
    }, [visible])

    useEffect(() => {
        if (activatingPlayer && !ineligibleIR.some((player) => player.id === activatingPlayer.id)) {
            setPhase('ineligible')
            setActivatingPlayer(null)
        }
    }, [activatingPlayer, ineligibleIR])

    async function handleActivate(player: RosterPlayer) {
        if (hasRoom) {
            setLoadingId(player.id)
            try {
                await onActivate(player)
            } finally {
                setLoadingId(null)
            }
        } else {
            // Need to drop someone first
            setActivatingPlayer(player)
            setPhase('drop-to-activate')
        }
    }

    async function handleDropAndActivate(dropPlayer: RosterPlayer) {
        if (!activatingPlayer || !ineligibleIR.some((player) => player.id === activatingPlayer.id)) return
        setLoadingId(dropPlayer.id)
        try {
            await onDropAndActivate(dropPlayer, activatingPlayer)
        } finally {
            setLoadingId(null)
        }
    }

    const handleRequestClose = () => {
        if (loadingId !== null) return
        reset()
        onCancel()
    }

    return (
        <Sheet
            visible={visible}
            onClose={handleRequestClose}
            title={phase === 'ineligible' ? 'Resolve IR status' : 'Drop to activate'}
        >
            {phase === 'ineligible' ? (
                <>
                    <Text style={styles.sub}>
                        Activate these players before adding{' '}
                        <Text style={styles.playerName}>{pendingPlayerName}</Text>.
                    </Text>
                    <View style={styles.list}>
                        {irOptions.map((rp) => (
                            <PlayerLine
                                key={rp.id}
                                player={rp}
                                action={(
                                    <Button
                                        title="Activate"
                                        size="sm"
                                        onPress={() => handleActivate(rp)}
                                        disabled={loadingId !== null}
                                        loading={loadingId === rp.id}
                                        accessibilityLabel={`Activate ${rp.players.display_name}`}
                                    />
                                )}
                            />
                        ))}
                    </View>
                </>
            ) : (
                <>
                    <Text style={styles.sub}>
                        Drop a player to activate{' '}
                        <Text style={styles.playerName}>{activatingPlayer?.players.display_name}</Text> from IR.
                    </Text>
                    <View style={styles.list}>
                        {dropOptions.map((rp) => (
                            <PlayerLine
                                key={rp.id}
                                player={rp}
                                action={(
                                    <Button
                                        title="Drop"
                                        size="sm"
                                        variant="danger"
                                        onPress={() => handleDropAndActivate(rp)}
                                        disabled={loadingId !== null}
                                        loading={loadingId === rp.id}
                                        accessibilityLabel={`Drop ${rp.players.display_name}`}
                                    />
                                )}
                            />
                        ))}
                    </View>
                </>
            )}


        </Sheet>
    )
}

const styles = StyleSheet.create({
    sub: { ...textStyles.body, marginBottom: spacing.md },
    playerName: { color: colors.primaryDark, fontWeight: fontWeight.semibold },
    list: { borderTopWidth: 1, borderTopColor: colors.separator },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeight,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.md,
    },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
})
