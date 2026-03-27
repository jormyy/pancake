const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

export { API_URL }

export async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })

    const json = await res.json()
    if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `API error: ${res.status}`)
    }
    return json as T
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`)
    const json = await res.json()
    if (!res.ok || json?.ok === false) {
        throw new Error(json?.error ?? `API error: ${res.status}`)
    }
    return json as T
}
