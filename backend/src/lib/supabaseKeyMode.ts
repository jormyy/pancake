export type SupabaseAdminKeyMode = 'modern-secret' | 'legacy-service-role' | 'missing'

export function getSupabaseAdminKeyMode(env: NodeJS.ProcessEnv = process.env): SupabaseAdminKeyMode {
    if (env.PANCAKE_SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEY) return 'modern-secret'
    if (env.SUPABASE_SERVICE_ROLE_KEY) return 'legacy-service-role'
    return 'missing'
}
