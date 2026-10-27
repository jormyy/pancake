import { onSessionCachesCleared } from '@/lib/session-cache-registry'

const PREFIX = 'pancake:editor-draft:'

export function readEditorDraft<T>(kind: string, owner: string, valid: (value: unknown) => value is T): T | null {
    try {
        const raw = globalThis.sessionStorage?.getItem(PREFIX + kind)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed.owner === owner && valid(parsed.value)) return parsed.value
        globalThis.sessionStorage.removeItem(PREFIX + kind)
    } catch {}
    return null
}

export function saveEditorDraft(kind: string, owner: string, value: unknown): boolean {
    try {
        if (!globalThis.sessionStorage) return false
        globalThis.sessionStorage.setItem(PREFIX + kind, JSON.stringify({ owner, value }))
        return true
    } catch { return false }
}

export function clearEditorDraft(kind: string, owner: string): void {
    try {
        const raw = globalThis.sessionStorage?.getItem(PREFIX + kind)
        if (raw && JSON.parse(raw).owner === owner) globalThis.sessionStorage.removeItem(PREFIX + kind)
    } catch {}
}

onSessionCachesCleared(() => {
    try {
        const storage = globalThis.sessionStorage
        if (!storage) return
        for (let index = storage.length - 1; index >= 0; index--) {
            const key = storage.key(index)
            if (key?.startsWith(PREFIX)) storage.removeItem(key)
        }
    } catch {}
})
