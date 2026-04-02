import { createHmac } from 'crypto'
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

function base64urlDecode(str: string): string {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')
    return Buffer.from(padded, 'base64').toString('utf8')
}

function verifySupabaseJwt(token: string, secret: string): { sub: string; exp: number } | null {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [header, payload, sig] = parts

    const expected = createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')

    if (expected !== sig) return null

    let claims: { sub?: string; exp?: number }
    try {
        claims = JSON.parse(base64urlDecode(payload))
    } catch {
        return null
    }

    if (!claims.sub || !claims.exp) return null
    if (Date.now() / 1000 > claims.exp) return null

    return { sub: claims.sub, exp: claims.exp }
}

// ── Plugin ────────────────────────────────────────────────────

const SKIP_ROUTES = new Set(['/health', '/games/today'])

export default async function authPlugin(app: FastifyInstance) {
    const secret = process.env.SUPABASE_JWT_SECRET
    if (!secret) {
        throw new Error('SUPABASE_JWT_SECRET env var is required')
    }

    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (SKIP_ROUTES.has(request.url)) return

        const authHeader = request.headers.authorization
        if (!authHeader?.startsWith('Bearer ')) {
            throw new AppError('Missing or invalid Authorization header', 401)
        }

        const token = authHeader.slice(7)
        const claims = verifySupabaseJwt(token, secret)
        if (!claims) {
            throw new AppError('Invalid or expired token', 401)
        }

        request.userId = claims.sub
    })
}
