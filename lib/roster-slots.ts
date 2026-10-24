import type { RosterSlotPlan } from '@/lib/lineup'
import type { RosterPlayer } from '@/lib/roster'

const PLAYER_POSITION_ORDER = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE']

function rosterSlotRank(player: RosterPlayer): number {
    const eligible = player.players.eligible_positions?.length
        ? player.players.eligible_positions
        : player.players.position ? [player.players.position] : []
    const rank = PLAYER_POSITION_ORDER.findIndex(slot => eligible.includes(slot))
    return rank === -1 ? PLAYER_POSITION_ORDER.length : rank
}

export function compareRosterBySlot(a: RosterPlayer, b: RosterPlayer): number {
    return rosterSlotRank(a) - rosterSlotRank(b)
        || (a.players.display_name ?? '').localeCompare(b.players.display_name ?? '')
}

// Display order for starting slots; league templates arrive unordered.
const STARTER_SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL']
const RESERVE_SLOT_TYPES = new Set(['BE', 'IR', 'TX'])

type RosterSlotRow<P> = { slotType: string; player: P | null }

function starterRank(slotType: string): number {
    const rank = STARTER_SLOT_ORDER.indexOf(slotType)
    return rank === -1 ? STARTER_SLOT_ORDER.length : rank
}

/**
 * Splits the active roster into the league's starting slots and the bench for
 * one date's lineup. Every starting slot is listed, filled or empty; the bench
 * lists unassigned players, then empty places up to the active roster limit.
 */
export function arrangeActiveRoster<P extends { players: { id: string } }>(
    active: P[],
    plan: RosterSlotPlan | null | undefined,
    rosterSize: number,
): { starters: RosterSlotRow<P>[]; bench: RosterSlotRow<P>[] } {
    const slots = (plan?.slots ?? [])
        .filter((slot) => !RESERVE_SLOT_TYPES.has(slot.slotType) && slot.slotCount > 0)
        .sort((a, b) => starterRank(a.slotType) - starterRank(b.slotType))
    const bySlot = new Map<string, P[]>()
    for (const player of active) {
        const slotType = plan?.assignments[player.players.id]
        if (!slotType || RESERVE_SLOT_TYPES.has(slotType)) continue
        bySlot.set(slotType, [...(bySlot.get(slotType) ?? []), player])
    }
    const placed = new Set<P>()
    const starters: RosterSlotRow<P>[] = []
    for (const slot of slots) {
        const assigned = bySlot.get(slot.slotType) ?? []
        for (let i = 0; i < slot.slotCount; i++) {
            const player = assigned[i] ?? null
            if (player) placed.add(player)
            starters.push({ slotType: slot.slotType, player })
        }
    }
    const bench: RosterSlotRow<P>[] = active
        .filter((player) => !placed.has(player))
        .map((player) => ({ slotType: 'BE', player }))
    for (let i = starters.length + bench.length; i < rosterSize; i++) bench.push({ slotType: 'BE', player: null })
    return { starters, bench }
}

/** Short label shown in a roster row's slot column. */
export function rosterSlotLabel(slotType: string): string {
    if (slotType === 'BE') return 'BENCH'
    if (slotType === 'TX') return 'TAXI'
    return slotType
}
