import { queueMutation, type MutationInput } from '@/lib/cache/mutation-queue'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { requestId } from '@/lib/api-client'

export type PwaMutationOptions = { requestId?: string; waitForOnline?: boolean; signal?: AbortSignal; queued?: MutationInput }

export function assertMutationOnline(): void {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Connect to the internet to make this change.')
}

async function waitForOnline(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (typeof navigator === 'undefined' || navigator.onLine !== false || typeof window === 'undefined') return
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            window.removeEventListener('online', online)
            signal?.removeEventListener('abort', aborted)
        }
        const online = () => { cleanup(); resolve() }
        const aborted = () => { cleanup(); reject(signal?.reason) }
        window.addEventListener('online', online, { once: true })
        signal?.addEventListener('abort', aborted, { once: true })
    })
}

export async function withPwaMutation<T>(reason: string, write: (requestId: string) => PromiseLike<T>, options: PwaMutationOptions = {}): Promise<T> {
    const id = requestId(options.requestId)
    const release = holdPwaUpdate(reason)
    try {
        if (options.queued) return await queueMutation<T>(options.queued, id)
        if (options.waitForOnline && typeof navigator !== 'undefined' && navigator.onLine === false) await waitForOnline(options.signal)
        options.signal?.throwIfAborted()
        return await write(id)
    } finally {
        release()
    }
}
