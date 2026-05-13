import 'dotenv/config'
import { buildApp } from './app'
import { registerCronJobs } from './cron'
import { CONFIG } from './config'

process.on('uncaughtException', (err) => {
    console.error('[crash] uncaughtException:', err)
    process.exit(1)
})
process.on('unhandledRejection', (err) => {
    console.error('[crash] unhandledRejection:', err)
    process.exit(1)
})

// Validate required env vars. Prefer Supabase's non-legacy secret key; keep the
// service-role JWT fallback for local Supabase CLI compatibility.
if (
    !process.env.SUPABASE_URL ||
    !(
        process.env.PANCAKE_SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY
    )
) {
    console.error(
        '[startup] Missing SUPABASE_URL and PANCAKE_SUPABASE_SECRET_KEY/SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY',
    )
    process.exit(1)
}
console.log('[startup] Env vars OK — starting server')

async function main() {
    const app = await buildApp()
    if (process.env.DISABLE_CRON === '1') {
        app.log.warn('Cron jobs disabled by DISABLE_CRON=1')
    } else {
        registerCronJobs()
    }

    app.listen({ port: CONFIG.PORT, host: '0.0.0.0' }, (err) => {
        if (err) {
            app.log.error(err)
            process.exit(1)
        }
        console.log(`Backend running on port ${CONFIG.PORT}`)
    })
}

main()
