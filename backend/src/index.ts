import 'dotenv/config'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { registerCronJobs } from './cron'
import { CONFIG } from './config'
import { isModernSupabaseSecretKey } from './lib/supabaseKeyMode'

// Holds the Fastify instance once main() has constructed it so the top-level
// shutdown handler can close it gracefully. Stays null until buildApp() resolves.
let appRef: FastifyInstance | null = null
let shuttingDown = false

async function shutdown(reason: string, code = 1): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[shutdown] ${reason}`)
    const app = appRef
    if (app) {
        try {
            await Promise.race([
                app.close(),
                new Promise<void>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('app.close timeout after 10s')),
                        10_000,
                    ),
                ),
            ])
        } catch (err) {
            console.error('[shutdown] app.close failed:', err)
        }
    }
    process.exit(code)
}

process.on('uncaughtException', (err) => {
    console.error('[crash] uncaughtException:', err)
    void shutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (err) => {
    console.error('[crash] unhandledRejection:', err)
    void shutdown('unhandledRejection', 1)
})
process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0)
})
process.on('SIGINT', () => {
    void shutdown('SIGINT', 0)
})

// Validate required env vars. Supabase admin access must use non-legacy secret
// keys; legacy service-role JWTs are intentionally rejected.
if (
    !process.env.SUPABASE_URL ||
    !isModernSupabaseSecretKey()
) {
    console.error(
        '[startup] Missing SUPABASE_URL or modern PANCAKE_SUPABASE_SECRET_KEY/SUPABASE_SECRET_KEY',
    )
    process.exit(1)
}
console.log('[startup] Env vars OK — starting server')

async function main() {
    const app = await buildApp()
    appRef = app
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
