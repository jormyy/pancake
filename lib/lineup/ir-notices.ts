export type IrNotice = {
    playerId: string
    playerName: string
    reason: string
    action: string
}

const REASON_TEXT: Record<string, string> = {
    healthy_ir_bench_full: 'Healthy on IR, but the active roster is full.',
    healthy_ir_swap_available: 'Healthy on IR, but the active roster is full. An injured player can take the spot.',
    healthy_ir_swap_locked: 'Healthy on IR, but the active roster is full. The injured player who could take the spot is locked by a game or a pending move.',
    ir_choice_uncertain: 'Injured players are competing for the last IR spot and their return dates are unclear.',
    taxi_ineligible: 'No longer eligible for the taxi squad.',
}

export function describeIrNotice(notice: IrNotice): { reason: string; action: string } {
    return {
        reason: REASON_TEXT[notice.reason] ?? 'Needs your decision.',
        action: notice.action,
    }
}
