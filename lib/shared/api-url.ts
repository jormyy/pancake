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
