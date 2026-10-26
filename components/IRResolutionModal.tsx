import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { View, Text, StyleSheet } from 'react-native'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import { orderRosterOptions } from '@/lib/player-roster-options'
import { colors, fontWeight, spacing, table, textStyles } from '@/constants/tokens'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

type Props = {
    visible: boolean
    ineligibleIR: RosterPlayer[]
    activeRoster: RosterPlayer[]
    rosterSize: number
    pendingPlayerName: string
    irAvailable?: boolean
    serverMessage?: string | null
    onRefresh?: () => void
    onActivate: (player: RosterPlayer) => Promise<void>
    onDropAndActivate: (dropPlayer: RosterPlayer, activatePlayer: RosterPlayer) => Promise<void>
    onDrop?: (player: RosterPlayer) => Promise<void>
    onMoveToIR?: (player: RosterPlayer) => Promise<void>
    onCancel: () => void
}

function PlayerLine({ player, message, action }: { player: RosterPlayer; message?: string; action: ReactNode }) {
    const p = player.players
    return <View style={styles.row}>
        <PlayerRowContent name={p.display_name} nbaId={p.nba_id} team={p.nba_team}
            positions={p.eligible_positions?.length ? p.eligible_positions : p.position ? [p.position] : []}
            yearsExp={p.years_exp} careerGames={p.career_regular_season_games} injuryStatus={p.injury_status} stats={message} />
        <View style={styles.actions}>{action}</View>
    </View>
}

export function IRResolutionModal({ visible, ineligibleIR, activeRoster, rosterSize, pendingPlayerName, irAvailable = false, serverMessage, onRefresh, onActivate, onDropAndActivate, onDrop, onMoveToIR, onCancel }: Props) {
    const [activatingPlayer, setActivatingPlayer] = useState<RosterPlayer | null>(null)
    const [loadingId, setLoadingId] = useState<string | null>(null)
    const reserveOptions = useMemo(() => orderRosterOptions(ineligibleIR), [ineligibleIR])
    const activeOptions = useMemo(() => orderRosterOptions(activeRoster), [activeRoster])
    const excess = activeRoster.length - rosterSize

    useEffect(() => {
        if (visible) { setActivatingPlayer(null); setLoadingId(null) }
    }, [visible])
    useEffect(() => {
        if (activatingPlayer && !ineligibleIR.some(player => player.id === activatingPlayer.id)) setActivatingPlayer(null)
    }, [activatingPlayer, ineligibleIR])

    async function run(player: RosterPlayer, action: () => Promise<void>) {
        if (loadingId !== null) return
        setLoadingId(player.id)
        try { await action() } finally { setLoadingId(null) }
    }
    function activate(player: RosterPlayer) {
        if (activeRoster.length >= rosterSize) setActivatingPlayer(player)
        else void run(player, () => onActivate(player))
    }
    function fixes(player: RosterPlayer, reserved: boolean) {
        return <>
            {reserved ? <Button title="Activate" size="sm" onPress={() => activate(player)} disabled={loadingId !== null} accessibilityLabel={`Activate ${player.players.display_name}`} /> : null}
            {irAvailable && !player.is_on_ir && isIREligible(player.players.injury_status) && onMoveToIR ? <Button title="Move to IR" size="sm" variant="outline" onPress={() => run(player, () => onMoveToIR(player))} disabled={loadingId !== null} accessibilityLabel={`Move ${player.players.display_name} to IR`} /> : null}
            {onDrop ? <Button title="Drop" size="sm" variant="outline" onPress={() => run(player, () => onDrop(player))} disabled={loadingId !== null} accessibilityLabel={`Drop ${player.players.display_name}`} /> : null}
        </>
    }
    return <Sheet visible={visible} onClose={() => { if (loadingId === null) onCancel() }} title={activatingPlayer ? 'Drop to activate' : 'Resolve roster'}>
        {activatingPlayer ? <>
            <Text style={styles.sub}>Drop a player to activate <Text style={styles.playerName}>{activatingPlayer.players.display_name}</Text> from {activatingPlayer.is_on_taxi ? 'taxi' : 'IR'}.</Text>
            <View style={styles.list}>{activeOptions.map(player => <PlayerLine key={player.id} player={player} action={<Button title="Drop" size="sm" variant="outline" onPress={() => run(player, () => onDropAndActivate(player, activatingPlayer))} disabled={loadingId !== null} loading={loadingId === player.id} accessibilityLabel={`Drop ${player.players.display_name}`} />} />)}</View>
        </> : <>
            <Text style={styles.sub}>Fix your roster before continuing{pendingPlayerName ? ` with ${pendingPlayerName}` : ''}.</Text>
            {serverMessage ? <Text style={styles.sub}>{serverMessage}</Text> : null}
            <View style={styles.list}>{reserveOptions.map(player => <PlayerLine key={player.id} player={player} message={`No longer eligible for ${player.is_on_taxi ? 'taxi' : 'IR'}.`} action={fixes(player, true)} />)}</View>
            {excess > 0 ? <>
                <Text style={styles.sub}>Active roster is {excess} over the limit.</Text>
                <View style={styles.list}>{activeOptions.map(player => <PlayerLine key={player.id} player={player} action={fixes(player, false)} />)}</View>
            </> : null}
            {serverMessage && onRefresh ? <Button title="Refresh roster" variant="outline" onPress={onRefresh} /> : null}
        </>}
    </Sheet>
}

const styles = StyleSheet.create({
    sub: { ...textStyles.body, marginBottom: spacing.md },
    playerName: { color: colors.primaryDark, fontWeight: fontWeight.semibold },
    list: { borderTopWidth: 1, borderTopColor: colors.separator },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: table.rowHeight, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.separator, gap: spacing.sm },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs, maxWidth: '60%' },
})
