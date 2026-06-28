export type SupabaseAdminKeyMode = 'modern-secret' | 'missing'

export function getSupabaseAdminKeyMode(env: NodeJS.ProcessEnv = process.env): SupabaseAdminKeyMode {
    if (env.PANCAKE_SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEY) return 'modern-secret'
    return 'missing'
}
