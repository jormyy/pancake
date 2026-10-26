import type { LineupSelection } from '@/lib/lineup'

export type LineupDraft = { selection: LineupSelection | null; playerId: string | null }

export function isLineupDraft(value: unknown): value is LineupDraft {
    if (!value || typeof value !== 'object') return false
    const draft = value as Record<string, unknown>
    if (draft.selection === null) return draft.playerId === null
    if (!draft.selection || typeof draft.selection !== 'object' || typeof draft.playerId !== 'string') return false
    const selection = draft.selection as Record<string, unknown>
    return ['starter', 'bench', 'ir', 'taxi'].includes(String(selection.kind))
        && Number.isSafeInteger(selection.index) && Number(selection.index) >= 0
}
