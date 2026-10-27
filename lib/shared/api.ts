import { configureMutationReplay, pendingMutations, mutationRowIds } from '@/lib/cache/mutation-queue'
import { refreshScreenVersions } from '@/lib/cache/screen-cache'
import { sessionOwner , sessionGeneration } from '@/lib/session-cache-registry'
import { supabase } from '@/lib/supabase'
import { RequestError } from '@/lib/shared/errors'
import { createMutationFetch, requestId } from '@/lib/api-client'
import { withPwaMutation } from '@/lib/shared/pwa-mutation'

import { API_URL } from '@/lib/shared/api-url'
export { API_URL, resolveDefaultApiUrl } from '@/lib/shared/api-url'
const DEFAULT_API_URL = API_URL
const API_URL_OVERRIDE_KEY = 'PANCAKE_API_URL'
const API_URL_OVERRIDE_PARAM = 'pancake_api_url'

function runtimeApiUrlOverride(): string | null {
    if (process.env.NODE_ENV === 'production') return null
    if (typeof window === 'undefined') return null

    try {
        const paramValue = new URLSearchParams(window.location.search).get(API_URL_OVERRIDE_PARAM)
        if (paramValue) {
            window.localStorage.setItem(API_URL_OVERRIDE_KEY, paramValue)
            return paramValue
        }
        return window.localStorage.getItem(API_URL_OVERRIDE_KEY)
    } catch {
        return null
    }
}

function apiUrl(): string {
    return (runtimeApiUrlOverride() ?? DEFAULT_API_URL).replace(/\/+$/, '')
}

function apiErrorMessage(json: { error?: unknown; message?: unknown } | null, status: number): string {
    const error = typeof json?.error === 'string' && json.error.trim() ? json.error.trim() : null
    const message = typeof json?.message === 'string' && json.message.trim() ? json.message.trim() : null

    return message ?? error ?? `API error: ${status}`
}

async function authHeaders(options: { accessToken?: string; expectedUserId?: string }): Promise<Record<string, string>> {
    let token = options.accessToken
    if (!token) {
        const { data: { session } } = await supabase.auth.getSession()
        if (options.expectedUserId && session?.user.id !== options.expectedUserId) throw new Error('Your account changed. Please retry.')
        token = session?.access_token
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }
    return headers
}

const DEFAULT_TIMEOUT_MS = 30_000

interface ApiRequestOptions {
    requestId?: string
    timeoutMs?: number
    /** Act as this session instead of the stored one (cleanup after local sign-out). */
    accessToken?: string
    /** Refuse to send when the stored session belongs to someone else (ignored with accessToken). */
    expectedUserId?: string
    beforeSend?: () => Promise<void>
}

function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const name = (err as { name?: unknown }).name
    return name === 'AbortError' || name === 'TimeoutError'
}

function wrapAbortAsTimeout(err: unknown, timeoutMs: number): never {
    if (isAbortError(err)) {
        throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw err
}

export async function apiPost<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    options: ApiRequestOptions = {},
): Promise<T> {
    const id = requestId(options.requestId ?? (typeof body.requestId === 'string' ? body.requestId : undefined))
    const payload = JSON.stringify({ ...body, requestId: id })
    const accountId = options.expectedUserId ?? sessionOwner()
    const leagueId = typeof body.leagueId === 'string' ? body.leagueId : null
    const rowIds = [...mutationRowIds(body), ...(path.match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [])]
    if (accountId && (typeof navigator !== 'undefined' && navigator.onLine === false || pendingMutations(accountId).length > 0)) return withPwaMutation(`API ${path}`, () => sendApiPost<T>(path, payload, { ...options, requestId: id }), { requestId: id, queued: { accountId, leagueId, rowIds, path, body: payload } })
    const result = await withPwaMutation(`API ${path}`, () => sendApiPost<T>(path, payload, { ...options, requestId: id }), { requestId: id, waitForOnline: true })
    await refreshScreenVersions(leagueId ?? undefined)
    return result
}

async function sendApiPost<T>(path: string, body: string, options: ApiRequestOptions): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            controller.abort()
            reject(new Error(`Request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
    })

    const request = async (): Promise<T> => {
        let res: Response
        try {
            const headers = await authHeaders(options)
            headers['x-request-id'] = options.requestId!
            await options.beforeSend?.()
            res = await createMutationFetch((input, init) => fetch(input, init), sessionGeneration)(`${apiUrl()}${path}`, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            })
        } catch (err) {
            wrapAbortAsTimeout(err, timeoutMs)
        }

        const json = await res!.json()
        if (!res!.ok || json?.ok === false) {
            throw new RequestError(apiErrorMessage(json, res!.status), {
                code: typeof json?.code === 'string' ? json.code : undefined,
            })
        }
        return json as T
    }

    try {
        return await Promise.race([request(), timeout])
    } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    }
}

configureMutationReplay(async mutation => {
    const result = await withPwaMutation(`API ${mutation.path}`, () => sendApiPost(mutation.path, mutation.body, { requestId: mutation.id, expectedUserId: mutation.accountId }), { requestId: mutation.id })
    await refreshScreenVersions(mutation.leagueId ?? undefined)
    return result
})
