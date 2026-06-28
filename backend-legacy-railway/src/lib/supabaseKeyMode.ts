export type SupabaseAdminKeyMode = 'modern-secret' | 'legacy-service-role' | 'missing'

export function getSupabaseAdminKeyMode(env: NodeJS.ProcessEnv = process.env): SupabaseAdminKeyMode {
    const key = env.PANCAKE_SUPABASE_SECRET_KEY ?? env.SUPABASE_SECRET_KEY
    if (!key) return 'missing'
    if (key.startsWith('sb_secret_')) return 'modern-secret'
    return 'legacy-service-role'
}

export function isModernSupabaseSecretKey(env: NodeJS.ProcessEnv = process.env): boolean {
    return getSupabaseAdminKeyMode(env) === 'modern-secret'
}
