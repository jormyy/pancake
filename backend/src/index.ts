import 'dotenv/config'
import { buildApp } from './app'
import { registerCronJobs } from './cron'
import { CONFIG } from './config'

process.on('uncaughtException', (err) => console.error('[crash] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[crash] unhandledRejection:', err))

// Validate required env vars
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[startup] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
}
console.log('[startup] Env vars OK — starting server')

async function main() {
    const app = await buildApp()
    registerCronJobs()

    app.listen({ port: CONFIG.PORT, host: '0.0.0.0' }, (err) => {
        if (err) {
            app.log.error(err)
            process.exit(1)
        }
        console.log(`Backend running on port ${CONFIG.PORT}`)
    })
}

main()
