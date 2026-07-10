import { supabase } from '@/lib/supabase'

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim()
const configuredSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim()

type ApiUrlConfig = {
    configuredApiUrl: string | undefined
    configuredSupabaseUrl: string | undefined
}

export function resolveDefaultApiUrl({
    configuredApiUrl,
    configuredSupabaseUrl,
}: ApiUrlConfig): string {
    if (configuredSupabaseUrl) return `${configuredSupabaseUrl.replace(/\/+$/, '')}/functions/v1/api`
    if (configuredApiUrl) return configuredApiUrl
    throw new Error('EXPO_PUBLIC_API_URL or EXPO_PUBLIC_SUPABASE_URL is required.')
}

const DEFAULT_API_URL = resolveDefaultApiUrl({ configuredApiUrl, configuredSupabaseUrl })
export const API_URL = DEFAULT_API_URL
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

    if (message && (!error || error === 'Bad Request')) {
        return message
    }
    return error ?? message ?? `API error: ${status}`
}

async function authHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`
    }
    return headers
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface ApiRequestOptions {
    timeoutMs?: number
}

function buildAbortSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
    // Prefer the standard `AbortSignal.timeout` when available. Fall back to
    // a manual AbortController for older runtimes (some RN/Hermes builds).
    const ctor = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal })
    if (typeof ctor.timeout === 'function') {
        return { signal: ctor.timeout(timeoutMs), cancel: () => undefined }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return { signal: controller.signal, cancel: () => clearTimeout(timer) }
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const abort = buildAbortSignal(timeoutMs)
    let res: Response
    try {
        res = await fetch(`${apiUrl()}${path}`, {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify(body),
            signal: abort.signal,
        })
    } catch (err) {
        wrapAbortAsTimeout(err, timeoutMs)
    } finally {
        abort.cancel()
    }

    const json = await res!.json()
    if (!res!.ok || json?.ok === false) {
        throw new Error(apiErrorMessage(json, res!.status))
    }
    return json as T
}
