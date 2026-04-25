import { jwtVerify, JWTPayload } from 'jose'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from './errorHandler'

declare module 'fastify' {
    interface FastifyRequest {
        userId: string
    }
}

// ── JWT verification ──────────────────────────────────────────
// Supabase issues HS256 JWTs. We verify the signature with the
// SUPABASE_JWT_SECRET env var (available in Dashboard → Settings → API).
// Using `jose` library instead of custom crypto for correctness and safety.

async function verifySupabaseJwt(token: string, secret: string): Promise<JWTPayload | null> {
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
            algorithms: ['HS256'],
            clockTolerance: 60, // 1 minute leeway for clock skew
        })
        return payload
    } catch {
        return null
    }
}

// ── Plugin ────────────────────────────────────────────────────

const SKIP_ROUTES = new Set(['/health', '/games/today'])

export default async function authPlugin(app: FastifyInstance) {
    const secret = process.env.SUPABASE_JWT_SECRET
    if (!secret) {
        throw new Error('SUPABASE_JWT_SECRET env var is required')
    }

    app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
        const pathname = request.url.split('?')[0]
        if (SKIP_ROUTES.has(pathname)) return

        const authHeader = request.headers.authorization
        if (!authHeader?.startsWith('Bearer ')) {
            throw new AppError('Missing or invalid Authorization header', 401)
        }

        const token = authHeader.slice(7)
        const claims = await verifySupabaseJwt(token, secret)
        if (!claims || !claims.sub) {
            throw new AppError('Invalid or expired token', 401)
        }

        request.userId = claims.sub
    })
}
