import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { resolveCorsOrigin } from '../src/lib/cors'

const SRC = path.resolve(__dirname, '../src')
const ROUTES = path.join(SRC, 'routes')

// Security invariant (regression for the removed /notify/trade abuse endpoint):
// push-notification content is ALWAYS constructed server-side. No HTTP route may
// accept a client-supplied {title, body} and forward it into a push, which let
// any league member spam/phish any other member with arbitrary content.

describe('notification content is server-constructed (no client-supplied push)', () => {
    it('the /notify/trade abuse endpoint is gone', () => {
        expect(existsSync(path.join(ROUTES, 'notifications.ts'))).toBe(false)
    })

    it('the app no longer registers a /notify route surface', () => {
        const app = readFileSync(path.join(SRC, 'app.ts'), 'utf8')
        expect(app).not.toMatch(/notifications/)
        expect(app).not.toMatch(/['"]\/notify['"]/)
    })

    it('no route handler forwards a client-supplied {title, body} into a notification', () => {
        for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
            const src = readFileSync(path.join(ROUTES, file), 'utf8')
            // Flag any handler that destructures BOTH title and body off the request body.
            const reqBodyShapes = src.match(/req(?:uest)?\.body\s+as\s+\{[^}]*\}/g) ?? []
            for (const shape of reqBodyShapes) {
                const hasTitle = /\btitle\b/.test(shape)
                const hasBody = /\bbody\b/.test(shape)
                expect(hasTitle && hasBody, `${file} accepts client push content: ${shape}`).toBe(false)
            }
        }
    })

    it('no schema defines a free-form push title/body input', () => {
        const schemas = readFileSync(path.join(SRC, 'schemas/index.ts'), 'utf8')
        expect(schemas).not.toMatch(/NotifyTradeBody/)
        expect(schemas).not.toMatch(/NOTIF_TITLE|NOTIF_BODY/)
    })
})

describe('CORS origin policy', () => {
    const original = process.env.CORS_ALLOWED_ORIGINS
    afterEach(() => {
        if (original === undefined) delete process.env.CORS_ALLOWED_ORIGINS
        else process.env.CORS_ALLOWED_ORIGINS = original
    })

    it('reflects any origin when unset (dev) and locks to an allowlist when set', () => {
        delete process.env.CORS_ALLOWED_ORIGINS
        expect(resolveCorsOrigin()).toBe(true)

        process.env.CORS_ALLOWED_ORIGINS = '*'
        expect(resolveCorsOrigin()).toBe(true)

        process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com, https://pancake.example.com'
        expect(resolveCorsOrigin()).toEqual(['https://app.example.com', 'https://pancake.example.com'])
    })
})
