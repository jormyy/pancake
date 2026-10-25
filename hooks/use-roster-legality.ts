import { useCallback, useEffect, useRef, useState } from 'react'
import { dropPlayer, getRoster, toggleIR, type RosterPlayer } from '@/lib/roster'
import { resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { getRosterProblems } from '@/lib/roster-problems'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'
import { showAlert } from '@/lib/alert'

export function useRosterLegality({ memberId, leagueId, rosterSize = 20, irSlots = 2, onChanged }: {
    memberId?: string | null
    leagueId?: string | null
    rosterSize?: number
    irSlots?: number
    onChanged?: () => unknown
}) {
    const identity = JSON.stringify([memberId, leagueId])
    const owner = useRef({ identity })
    if (owner.current.identity !== identity) owner.current = { identity }
    const requestOwner = owner.current
    const [snapshot, setSnapshot] = useState<{ owner: typeof requestOwner; roster: RosterPlayer[]; message?: string } | null>(null)
    const running = useRef<{ owner: typeof requestOwner; token: symbol } | null>(null)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const current = useCallback(() => mounted.current && owner.current === requestOwner, [requestOwner])
    const check = useCallback(async (knownRoster?: RosterPlayer[], message?: string) => {
        if (!memberId || !leagueId || !current()) return false
        const roster = knownRoster ?? await getRoster(memberId, leagueId)
        if (!current()) return false
        if (getRosterProblems(roster, rosterSize).length || message) {
            setSnapshot({ owner: requestOwner, roster, message })
            return false
        }
        setSnapshot(null)
        return true
    }, [memberId, leagueId, current, rosterSize, requestOwner])
    const report = useCallback(async (error: unknown) => {
        if (![RULE_CODES.ineligibleIr, RULE_CODES.ineligibleTaxi].some(code => code === errorCode(error))) return false
        try { await check(undefined, getErrorMessage(error)) } catch (readError) { if (current()) showAlert('Error', getErrorMessage(readError)) }
        return true
    }, [check, current])
    const resolve = useCallback(async (action: () => Promise<unknown>) => {
        if (running.current?.owner === requestOwner || !current()) return
        const token = Symbol('roster-resolution')
        running.current = { owner: requestOwner, token }
        try {
            await action()
            if (!current()) return
            await check()
            if (current()) await onChanged?.()
        } catch (error) {
            if (current()) showAlert('Error', getErrorMessage(error))
        } finally { if (running.current?.token === token) running.current = null }
    }, [current, check, onChanged, requestOwner])
    const activate = async (player: RosterPlayer, drop?: RosterPlayer) => {
        if (!memberId || !leagueId) return
        const result = await resolveRosterAddIRConflict({ memberId, leagueId, activatePlayer: player, dropPlayer: drop, rosterSize })
        if (result.status === 'locked') throw new Error(result.message)
    }
    const roster = snapshot?.owner === requestOwner ? snapshot.roster : []
    return {
        check,
        report,
        modalProps: {
            visible: snapshot?.owner === requestOwner,
            ineligibleIR: getRosterProblems(roster, rosterSize).flatMap(problem => problem.player ? [problem.player] : []),
            activeRoster: roster.filter(player => !player.is_on_ir && !player.is_on_taxi),
            rosterSize,
            irAvailable: roster.filter(player => player.is_on_ir).length < irSlots,
            serverMessage: snapshot?.owner === requestOwner ? snapshot.message : null,
            pendingPlayerName: '',
            onActivate: (player: RosterPlayer) => resolve(() => activate(player)),
            onDropAndActivate: (drop: RosterPlayer, player: RosterPlayer) => resolve(() => activate(player, drop)),
            onDrop: (player: RosterPlayer) => resolve(() => dropPlayer(player.id)),
            onMoveToIR: (player: RosterPlayer) => resolve(() => toggleIR(player.id, true)),
            onRefresh: () => { void resolve(async () => {}) },
            onCancel: () => setSnapshot(null),
        },
    }
}
