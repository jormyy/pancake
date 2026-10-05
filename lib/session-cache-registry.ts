// The signed-in user the caches belong to, and a generation that advances
// whenever that user changes: sign-out, a switch to another account, or a
// sign-in after sign-out. A request started in one generation must not feed a
// cache in the next. In-memory caches register here to be dropped on the same
// changes and whenever the persistent caches are cleared.
let owner: string | null | undefined
let generation = 0
const clearListeners = new Set<() => void>()

export function sessionGeneration(): number {
    return generation
}

/** Undefined until the auth layer reports a user; null while signed out. */
export function sessionOwner(): string | null | undefined {
    return owner
}

export function setSessionOwner(next: string | null): void {
    if (owner !== undefined && next !== owner) {
        generation += 1
        clearSessionCaches()
    }
    owner = next
}

export function onSessionCachesCleared(listener: () => void): void {
    clearListeners.add(listener)
}

export function clearSessionCaches(): void {
    for (const listener of clearListeners) listener()
}
