import { FastifyInstance } from 'fastify'
import { getSupabaseAdminKeyMode } from '../lib/supabaseKeyMode'

export default async function healthRoutes(app: FastifyInstance) {
    app.get('/health', async () => ({
        status: 'ok',
        supabaseAdminKeyMode: getSupabaseAdminKeyMode(),
    }))
}
