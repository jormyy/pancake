// In-memory caches that must not outlive the signed-in user register here;
// clearPersistentCaches() runs them at sign-out and on a change of user.
const clearListeners = new Set<() => void>()

export function onSessionCachesCleared(listener: () => void): void {
    clearListeners.add(listener)
}

export function clearSessionCaches(): void {
    for (const listener of clearListeners) listener()
}
