export type IrNotice = {
    playerId: string
    playerName: string
    reason: string
    action: string
}

const REASON_TEXT: Record<string, string> = {
    healthy_ir_bench_full: 'Healthy on IR, but the active roster is full.',
    ir_choice_uncertain: 'Injured players are competing for the last IR spot and their return dates are unclear.',
    taxi_ineligible: 'No longer eligible for the taxi squad.',
}

export function describeIrNotice(notice: IrNotice): { reason: string; action: string } {
    return {
        reason: REASON_TEXT[notice.reason] ?? 'Needs your decision.',
        action: notice.action,
    }
}
