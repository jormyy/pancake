import { createAuthStorage } from '@/lib/auth-storage'

type Revision = { id: string; signedOut: boolean; generation: number }
type Ticket = { revision: string; login: boolean }

// This records local logout, not server revocation. Only a new successful
// password/signup response may replace the signed-out state.
export function createAuthInvalidation(
    storage: ReturnType<typeof createAuthStorage>,
    fallback: ReturnType<typeof createAuthStorage>,
    key: string,
    changed: () => void,
) {
    const revisionKey = `${key}-local-logout`
    let memory: Revision = { id: '', signedOut: false, generation: 0 }
    const tickets = new Map<string, Ticket>()
    const revision = (): Revision => {
        const candidates: (Revision | null)[] = []
        for (const raw of [storage.read(revisionKey).value, fallback.read(revisionKey).value]) {
            if (!raw) { candidates.push(null); continue }
            try {
                const value = JSON.parse(raw) as Revision
                if (typeof value.id !== 'string' || typeof value.signedOut !== 'boolean'
                    || !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('Invalid logout marker')
                candidates.push(value)
            } catch { return { id: 'invalid', signedOut: true, generation: memory.generation } }
        }
        const [shared, tab] = candidates
        let next = memory
        // A failed primary write must not override a newer local logout.
        // At the same generation, shared storage carries a subsequent login.
        if (shared && shared.generation >= next.generation) next = shared
        if (tab && tab.generation > next.generation) next = tab
        memory = next
        return memory
    }
    const save = (next: Revision) => {
        memory = next
        storage.setItem(revisionKey, JSON.stringify(next))
        fallback.setItem(revisionKey, JSON.stringify(next))
    }
    const read = (name: string) => {
        const stored = storage.read(name)
        return name === key && revision().signedOut ? { ...stored, value: null } : stored
    }
    const setItem = (name: string, value: string) => {
        if (name === key) {
            const session = JSON.parse(value) as { access_token?: string }
            const token = session.access_token ?? ''
            const ticket = tickets.get(token)
            tickets.delete(token)
            const current = revision()
            const saved = storage.read(key).value
            let savedToken: string | undefined
            try { savedToken = saved ? (JSON.parse(saved) as { access_token?: string }).access_token : undefined } catch { /* Invalid saved sessions have no authority. */ }
            if ((!ticket && token !== savedToken) || (ticket && ticket.revision !== current.id) || (current.signedOut && !ticket?.login)) {
                throw new Error('An authentication response arrived after local sign-out.')
            }
            storage.setItem(name, value)
            if (ticket?.login && storage.read(name).value === value) {
                // A refresh started before this explicit login cannot replace its account.
                save({ id: crypto.randomUUID(), generation: current.generation + 1, signedOut: false })
                changed()
            }
            return
        }
        storage.setItem(name, value)
    }
    return {
        revisionKey,
        read,
        getItem: (name: string) => read(name).value,
        setItem,
        removeItem: storage.removeItem,
        invalidate: (shared = true) => {
            const next = { id: crypto.randomUUID(), signedOut: true, generation: revision().generation + 1 }
            if (shared) save(next)
            else { memory = next; fallback.setItem(revisionKey, JSON.stringify(next)) }
            if (shared) {
                storage.removeItem(key)
                storage.removeItem(`${key}-code-verifier`)
                storage.removeItem(`${key}-user`)
            }
            tickets.clear()
            changed()
        },
        receive: (value: Revision) => {
            // Storage is authoritative when readable. The message is a fallback
            // for another open tab whose browser denies storage operations.
            if (value.generation > memory.generation) memory = value
            revision()
            changed()
        },
        current: revision,
        fetch: (fetchImpl: typeof fetch): typeof fetch => async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
            if (!url.pathname.startsWith('/auth/v1/')) return fetchImpl(input, init)
            const started = revision().id
            if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
                const requested = typeof init?.body === 'string' ? JSON.parse(init.body).refresh_token : null
                const stored = JSON.parse(read(key).value ?? 'null')?.refresh_token
                // The SDK retries fetch rejections with the original refresh token.
                if (!requested || requested !== stored) throw new Error('Authentication changed before token refresh.')
            }
            const response = await fetchImpl(input, init)
            const body = response.status === 204 ? null : await response.text()
            if (revision().id !== started) throw new Error('Authentication changed while this request was in flight.')
            if (response.ok && body) {
                try {
                    const data = JSON.parse(body) as { access_token?: string }
                    if (typeof data.access_token === 'string') {
                        tickets.set(data.access_token, {
                            revision: started,
                            login: url.pathname === '/auth/v1/signup' || url.searchParams.get('grant_type') === 'password',
                        })
                        while (tickets.size > 8) tickets.delete(tickets.keys().next().value!)
                    }
                } catch { /* Preserve the SDK's response parsing and error. */ }
            }
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        },
    }
}
