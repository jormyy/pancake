import { holdPwaUpdate } from '@/lib/pwa-update-guard'

export async function withPwaMutation<T>(reason: string, write: () => PromiseLike<T>): Promise<T> {
    const release = holdPwaUpdate(reason)
    try {
        return await write()
    } finally {
        release()
    }
}
