import { supabase } from '@/lib/supabase'

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

export { API_URL }

async function authHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`
    }
    return headers
}

export async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(body),
    })

    const json = await res.json()
    if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `API error: ${res.status}`)
    }
    return json as T
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
        headers: await authHeaders(),
    })
    const json = await res.json()
    if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `API error: ${res.status}`)
    }
    return json as T
}
