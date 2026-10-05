import { sessionGeneration } from '@/lib/session-cache-registry'

class SessionChangedError extends Error {
    name = 'SessionChangedError'
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

// A database response belongs to the session that sent it. One that arrives
// after the signed-in user changed is discarded, so a request started before a
// sign-out, account switch, or re-login cannot fill a cache for the next
// session. The body is read here so the check covers the whole response.
export function fenceDataRequests(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('/rest/v1/')) return fetchImpl(input, init)
        const generation = sessionGeneration()
        const response = await fetchImpl(input, init)
        const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.text()
        if (sessionGeneration() !== generation) {
            throw new SessionChangedError('The signed-in user changed while this request was in flight.')
        }
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
}
