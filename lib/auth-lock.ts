import { NavigatorLockAcquireTimeoutError } from '@supabase/supabase-js'

/** The SDK caches initialization forever, including an acquisition rejection. */
export function createAuthClientLock(): typeof authNavigatorLock {
    let firstRequest = true
    return (name, acquireTimeout, fn) => {
        // The client constructor calls initialize synchronously before exposing the client.
        const timeout = firstRequest ? -1 : acquireTimeout
        firstRequest = false
        return authNavigatorLock(name, timeout, fn)
    }
}

/** Time out before admitting logout, without queuing a late logout behind startup. */
export async function waitForAuthInitialization(initialization: Promise<{ error: Error | null }>): Promise<{ error: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const result = await Promise.race([
            initialization.catch(error => ({ error })),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Your session is still starting. Try signing out again shortly.')), 5000)
            }),
        ])
        return result
    } finally {
        clearTimeout(timer)
    }
}

/** A timed-out waiter must not revoke a lock whose owner can still be running. */
export async function authNavigatorLock<R>(
    name: string,
    acquireTimeout: number,
    fn: () => Promise<R>,
): Promise<R> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let acquired = false
    const clearTimer = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
    }
    if (acquireTimeout > 0) {
        timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, acquireTimeout)
    }

    try {
        return await navigator.locks.request(
            name,
            acquireTimeout === 0
                ? { mode: 'exclusive', ifAvailable: true }
                : { mode: 'exclusive', signal: controller.signal },
            async (lock) => {
                clearTimer()
                if (!lock) {
                    if (acquireTimeout === 0) {
                        throw new NavigatorLockAcquireTimeoutError(`Auth lock "${name}" is unavailable`)
                    }
                    throw new Error(`Auth lock "${name}" was not granted`)
                }
                acquired = true
                return await fn()
            },
        )
    } catch (error) {
        // Browsers also cancel pending locks during navigation. Preserve that error;
        // only our own deadline can turn an acquisition cancellation into a timeout.
        if (!acquired && timedOut && error instanceof Error && error.name === 'AbortError') {
            throw new NavigatorLockAcquireTimeoutError(`Auth lock "${name}" timed out after ${acquireTimeout}ms`)
        }
        throw error
    } finally {
        clearTimer()
    }
}
