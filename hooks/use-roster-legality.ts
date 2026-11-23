import { useCallback, useEffect, useRef, useState } from 'react'
import { dropPlayer, getRoster, toggleIR, type RosterPlayer } from '@/lib/roster'
import { resolveRosterAddIRConflict, swapHealthyIrWithInjured } from '@/lib/roster-add-flow'
import { getRosterProblems } from '@/lib/roster-problems'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'
import { showAlert } from '@/lib/alert'
import { partitionRoster, sameRosterLimits, staleRosterLimitsNotice, type RosterLimits } from '@/lib/roster-capacity'

export function useRosterLegality({ memberId, leagueId, limits, onChanged }: {
    memberId?: string | null
    leagueId?: string | null
    limits: RosterLimits | null
    onChanged?: () => unknown
}) {
    const identity = JSON.stringify([memberId, leagueId])
    const owner = useRef({ identity })
    if (owner.current.identity !== identity) owner.current = { identity }
    const requestOwner = owner.current
    const limitsRef = useRef(limits)
    limitsRef.current = limits
    const limitsStillHold = useCallback((expected: RosterLimits | null) => {
        if (sameRosterLimits(expected, limitsRef.current)) return true
        const notice = staleRosterLimitsNotice(limitsRef.current)
        showAlert(notice.title, notice.message)
        return false
    }, [])
    const [snapshot, setSnapshot] = useState<{ owner: typeof requestOwner; roster: RosterPlayer[]; message?: string; limits: RosterLimits | null } | null>(null)
    const running = useRef<{ owner: typeof requestOwner; token: symbol } | null>(null)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const current = useCallback(() => mounted.current && owner.current === requestOwner, [requestOwner])
    const check = useCallback(async (knownRoster?: RosterPlayer[], message?: string, needsLimits = true) => {
        if (!memberId || !leagueId || !current()) return false
        const roster = knownRoster ?? await getRoster(memberId, leagueId)
        if (!current()) return false
        const problems = getRosterProblems(roster, limits?.rosterSize ?? null)
        if (problems.length || message) {
            setSnapshot({ owner: requestOwner, roster, message, limits })
            return false
        }
        setSnapshot(null)
        return !needsLimits || limits != null
    }, [memberId, leagueId, current, limits, requestOwner])
    const report = useCallback(async (error: unknown) => {
        if (!limits) return false
        if (![RULE_CODES.ineligibleIr, RULE_CODES.ineligibleTaxi].some(code => code === errorCode(error))) return false
        try { await check(undefined, getErrorMessage(error)) } catch (readError) { if (current()) showAlert('Error', getErrorMessage(readError)) }
        return true
    }, [check, current, limits])
    const resolve = useCallback(async (action: () => Promise<unknown>) => {
        if (running.current?.owner === requestOwner || !current()) return
        const token = Symbol('roster-resolution')
        running.current = { owner: requestOwner, token }
        try {
            const result = await action()
            if (!current() || result === false) return
            await check()
            if (current()) await onChanged?.()
        } catch (error) {
            if (current()) showAlert('Error', getErrorMessage(error))
        } finally { if (running.current?.token === token) running.current = null }
    }, [current, check, onChanged, requestOwner])
    const activate = async (player: RosterPlayer, drop?: RosterPlayer) => {
        if (!memberId || !leagueId) return false
        const expected = snapshot?.owner === requestOwner ? snapshot.limits : limits
        if (!limitsStillHold(expected) || !expected) { setSnapshot(null); return false }
        const result = await resolveRosterAddIRConflict({
            memberId, leagueId, activatePlayer: player, dropPlayer: drop, rosterSize: expected.rosterSize,
            stillValid: () => current() && limitsStillHold(expected),
        })
        if (result.status === 'stale') { if (current()) setSnapshot(null); return false }
        if (result.status === 'locked') throw new Error(result.message)
        return true
    }
    const swapWithInjured = async (healthyIrPlayer: RosterPlayer, injuredPlayer: RosterPlayer) => {
        if (!memberId || !leagueId) return false
        const expected = snapshot?.owner === requestOwner ? snapshot.limits : limits
        if (!limitsStillHold(expected) || !expected) { setSnapshot(null); return false }
        const result = await swapHealthyIrWithInjured({
            memberId, leagueId, healthyIrPlayer, injuredPlayer, rosterSize: expected.rosterSize,
            stillValid: () => current() && limitsStillHold(expected),
        })
        if (result.status === 'stale') { if (current()) setSnapshot(null); return false }
        if (result.status === 'locked') throw new Error(result.message)
        return true
    }
    const roster = snapshot?.owner === requestOwner ? snapshot.roster : []
    const partitioned = partitionRoster(roster)
    return {
        check,
        report,
        modalProps: {
            visible: snapshot?.owner === requestOwner,
            ineligibleIR: getRosterProblems(roster, limits?.rosterSize ?? null).flatMap(problem => problem.player ? [problem.player] : []),
            activeRoster: partitioned.active,
            rosterSize: limits?.rosterSize,
            irAvailable: limits ? partitioned.ir.length < limits.irSlots : false,
            serverMessage: snapshot?.owner === requestOwner ? snapshot.message : null,
            pendingPlayerName: '',
            onActivate: (player: RosterPlayer) => resolve(() => activate(player)),
            onDropAndActivate: (drop: RosterPlayer, player: RosterPlayer) => resolve(() => activate(player, drop)),
            onSwapWithInjured: (healthyIrPlayer: RosterPlayer, injuredPlayer: RosterPlayer) => resolve(() => swapWithInjured(healthyIrPlayer, injuredPlayer)),
            onDrop: (player: RosterPlayer) => resolve(() => dropPlayer(player.id)),
            onMoveToIR: (player: RosterPlayer) => resolve(() => toggleIR(player.id, true)),
            onRefresh: () => { void resolve(async () => {}) },
            onCancel: () => setSnapshot(null),
        },
    }
}
