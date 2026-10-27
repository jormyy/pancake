import { configureMutationReplay, pendingMutations, queueMutation, mutationRowIds } from '@/lib/cache/mutation-queue'
import { guardedRpcNames, requestId } from '@/lib/api-client'
import { sessionOwner } from '@/lib/session-cache-registry'
import { refreshScreenVersions } from '@/lib/cache/screen-cache'

type SavedResponse = { body: string; status: number; headers: [string, string][] }

export function queuedRpcFetch(fetcher: typeof fetch, origin: string, publicKey: string): typeof fetch {
    configureMutationReplay(async job => {
        const { supabase } = await import('@/lib/supabase')
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.user.id !== job.accountId) throw new Error('Your account changed. Please retry.')
        const response = await fetcher(`${origin}${job.path}`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, apikey: publicKey, 'x-request-id': job.id, 'Content-Type': 'application/json' }, body: job.body })
        const body = await response.text()
        if (!response.ok) {
            let message = 'Could not send this action.'
            try { message = (JSON.parse(body) as { message?: string }).message ?? message } catch {}
            throw new Error(message)
        }
        await refreshScreenVersions(job.leagueId ?? undefined)
        return { body, status: response.status, headers: [...response.headers] } satisfies SavedResponse
    }, 'rpc')
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        const name = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1]
        const accountId = sessionOwner()
        if (!accountId || !name || !guardedRpcNames.has(name) || typeof init?.body !== 'string' || url.origin !== new URL(origin).origin) return fetcher(input, init)
        const body = JSON.parse(init.body) as Record<string, unknown>
        const leagueId = typeof body.p_league_id === 'string' ? body.p_league_id : null
        if (typeof navigator !== 'undefined' && navigator.onLine === false || pendingMutations(accountId).length > 0) {
            const headers = new Headers(init.headers)
            const id = requestId(typeof body.p_request_id === 'string' ? body.p_request_id : headers.get('x-request-id') ?? undefined)
            const rowIds = mutationRowIds(body)
            const saved = await queueMutation<SavedResponse>({ accountId, leagueId, rowIds, path: url.pathname + url.search, body: init.body, transport: 'rpc' }, id)
            return new Response(saved.status === 204 ? null : saved.body, { status: saved.status, headers: saved.headers })
        }
        const response = await fetcher(input, init)
        if (response.ok) await refreshScreenVersions(leagueId ?? undefined)
        return response
    }
}
